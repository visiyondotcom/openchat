// Exports a rendered chat message to a downloadable PDF, entirely
// client-side (no backend round-trip). Used by the "Export to PDF"
// button on assistant replies — story generations, long-form writing,
// or any other text response someone wants to keep as a document.
//
// Approach: clone the message's rendered DOM node into an offscreen,
// print-styled (black-on-white, fixed width) container — the chat UI
// itself is dark-themed, and screenshotting it directly would produce a
// dark PDF that's unpleasant to read or print — then rasterize that
// clone with html2canvas and lay the resulting image across as many A4
// pages as it takes.
export async function exportMessageToPdf(elementId: string, fileName: string): Promise<void> {
  const source = document.getElementById(elementId);
  if (!source) throw new Error("Nothing to export");

  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import("jspdf"),
    import("html2canvas"),
  ]);

  const clone = source.cloneNode(true) as HTMLElement;
  // Strip hover-only action toolbars (copy/download/preview buttons on
  // code blocks and images) so they don't show up baked into the PDF.
  clone.querySelectorAll("[data-pdf-exclude]").forEach((el) => el.remove());

  const wrapper = document.createElement("div");
  wrapper.style.position = "fixed";
  wrapper.style.left = "-99999px";
  wrapper.style.top = "0";
  wrapper.style.width = "700px";
  wrapper.style.padding = "40px";
  wrapper.style.background = "#ffffff";
  wrapper.style.color = "#111111";
  wrapper.style.fontFamily = "Arial, Helvetica, sans-serif";
  wrapper.style.fontSize = "14px";
  wrapper.style.lineHeight = "1.6";
  clone.style.color = "#111111";
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);

  try {
    const canvas = await html2canvas(wrapper, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
    });

    const pdf = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    const imgData = canvas.toDataURL("image/png");

    let heightLeft = imgHeight;
    let position = 0;

    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;

    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    pdf.save(fileName);
  } finally {
    document.body.removeChild(wrapper);
  }
}
