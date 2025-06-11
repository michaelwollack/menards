const express = require("express");
const multer = require("multer");
const { PDFServicesSdk } = require("@adobe/pdfservices-node-sdk");

require("dotenv").config();
const app = express();
const upload = multer({ dest: "uploads/" });
const port = process.env.PORT || 3000;

app.post("/parse", upload.single("pdf"), async (req, res) => {
  try {
    const credentials = PDFServicesSdk.Credentials
      .servicePrincipalCredentialsBuilder()
      .withClientId(process.env.PDF_SERVICES_CLIENT_ID)
      .withClientSecret(process.env.PDF_SERVICES_CLIENT_SECRET)
      .build();

    const executionContext = PDFServicesSdk.ExecutionContext.create(credentials);

    const extractPDF = PDFServicesSdk.ExtractPDF;
    const extractOptions = new extractPDF.ExtractPDFOptions.Builder()
      .addElementsToExtract(extractPDF.ExtractElementType.TEXT)
      .build();

    const extractOperation = extractPDF.ExtractPDFOperation.createNew()
      .setInput(PDFServicesSdk.FileRef.createFromLocalFile(req.file.path))
      .setOptions(extractOptions);

    const result = await extractOperation.execute(executionContext);
    const outputPath = `output/result_${Date.now()}.zip`;
    await result.saveAsFile(outputPath);

    res.json({ message: "PDF parsed successfully", zip: outputPath });
  } catch (err) {
    console.error("Parsing failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
