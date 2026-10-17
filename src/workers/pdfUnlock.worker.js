const INPUT_PATH = '/input.pdf';
const OUTPUT_PATH = '/output.pdf';
const LOG_LIMIT = 4096;

const createLogBuffer = () => {
    let value = '';
    return {
        clear: () => { value = ''; },
        append: message => {
            if (value.length >= LOG_LIMIT) return;
            value += `${String(message)}\n`.slice(0, LOG_LIMIT - value.length);
        },
        read: () => value,
    };
};

const runCommand = (core, stdout, stderr, args) => {
    stdout.clear();
    stderr.clear();
    let exitCode = 0;
    try {
        const result = core.callMain(args);
        if (typeof result === 'number') exitCode = result;
    } catch (error) {
        if (typeof error?.status === 'number') exitCode = error.status;
        else throw error;
    }
    return { exitCode, diagnostics: `${stdout.read()}\n${stderr.read()}` };
};

const classifyFailure = ({ exitCode, diagnostics }) => {
    if (exitCode === 3) return 'WARNING_OUTPUT_REJECTED';
    if (/invalid password/i.test(diagnostics)) return 'INVALID_PASSWORD';
    if (/unsupported|unknown encryption|security handler/i.test(diagnostics)) return 'UNSUPPORTED_ENCRYPTION';
    if (/damaged|not a pdf|invalid pdf|xref|trailer/i.test(diagnostics)) return 'INVALID_PDF';
    return 'PROCESSING_FAILED';
};

const safeUnlink = (core, path) => {
    try { core.FS.unlink(path); } catch { /* absent files require no action */ }
};

self.onmessage = async ({ data }) => {
    const { id } = data ?? {};
    const sendError = code => self.postMessage({ id, type: 'error', code });
    let core;

    try {
        const coreUrl = new URL(data.coreJsUrl, self.location.href);
        const wasmUrl = new URL(data.wasmUrl, self.location.href);
        if (coreUrl.origin !== self.location.origin || wasmUrl.origin !== self.location.origin) {
            sendError('ENGINE_LOAD_FAILED');
            return;
        }

        importScripts(coreUrl.href);
        if (typeof createQpdfCore !== 'function') throw new Error('core unavailable');
        const response = await fetch(wasmUrl.href, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('core unavailable');
        const stdout = createLogBuffer();
        const stderr = createLogBuffer();
        core = await createQpdfCore({
            wasmBinary: new Uint8Array(await response.arrayBuffer()),
            noInitialRun: true,
            thisProgram: 'qpdf',
            print: stdout.append,
            printErr: stderr.append,
        });

        safeUnlink(core, INPUT_PATH);
        safeUnlink(core, OUTPUT_PATH);
        core.FS.writeFile(INPUT_PATH, new Uint8Array(data.input));

        const encryption = runCommand(core, stdout, stderr, ['--show-encryption', INPUT_PATH]);
        if (encryption.exitCode !== 0) {
            sendError(classifyFailure(encryption));
            return;
        }
        if (/File is not encrypted/i.test(encryption.diagnostics)) {
            sendError('UNENCRYPTED_PDF');
            return;
        }

        const inspection = runCommand(core, stdout, stderr, ['--requires-password', INPUT_PATH]);
        if (inspection.exitCode === 3) {
            sendError('PERMISSIONS_ONLY');
            return;
        }
        if (inspection.exitCode !== 0) {
            sendError(classifyFailure(inspection));
            return;
        }

        const result = runCommand(core, stdout, stderr, [
            `--password=${data.password}`,
            '--stream-data=preserve',
            '--decode-level=none',
            '--decrypt',
            INPUT_PATH,
            OUTPUT_PATH,
        ]);
        if (result.exitCode !== 0) {
            safeUnlink(core, OUTPUT_PATH);
            sendError(classifyFailure(result));
            return;
        }

        const output = core.FS.readFile(OUTPUT_PATH);
        const transferable = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
        self.postMessage({ id, type: 'success', output: transferable }, [transferable]);
    } catch {
        sendError(core ? 'PROCESSING_FAILED' : 'ENGINE_LOAD_FAILED');
    } finally {
        if (core) {
            safeUnlink(core, INPUT_PATH);
            safeUnlink(core, OUTPUT_PATH);
        }
        self.close();
    }
};
