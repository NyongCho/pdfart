export const downloadPdf = (data, filename, options = {}) => {
    const documentRef = options.documentRef ?? document;
    const urlApi = options.urlApi ?? URL;
    const blob = new Blob([data], { type: 'application/pdf' });
    const objectUrl = urlApi.createObjectURL(blob);
    const link = documentRef.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    documentRef.body.append(link);

    try {
        link.click();
    } finally {
        link.remove();
        urlApi.revokeObjectURL(objectUrl);
    }
};
