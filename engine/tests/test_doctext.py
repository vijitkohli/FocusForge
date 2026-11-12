# Run: engine/env/bin/python -m unittest discover -s engine/tests
import base64
import io
import os
import sys
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import doctext  # noqa: E402


def minimal_pdf(lines):
    """A one-page PDF with a real text layer (Helvetica), xref offsets computed."""
    content = "BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(
        "(%s) Tj T*" % l.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for l in lines
    ) + " ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        "/Resources << /Font << /F1 5 0 R >> >> >>",
        "<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(("%d 0 obj\n%s\nendobj\n" % (i, body)).encode("latin-1"))
    xref = out.tell()
    out.write(("xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)).encode())
    for off in offsets:
        out.write(("%010d 00000 n \n" % off).encode())
    out.write(("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)).encode())
    return out.getvalue()


def minimal_docx(paragraphs):
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join("<w:p><w:r><w:t>%s</w:t></w:r></w:p>" % p for p in paragraphs)
    xml = '<?xml version="1.0"?><w:document xmlns:w="%s"><w:body>%s</w:body></w:document>' % (ns, body)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", xml)
    return buf.getvalue()


def b64(data):
    return base64.b64encode(data).decode()


class DocTextTests(unittest.TestCase):
    def test_docx_from_zipfile_fixture(self):
        r = doctext.run({"kind": "docx", "data_b64": b64(minimal_docx(["Essay draft", "Second para"])), "max_chars": 1000})
        self.assertEqual(r, {"text": "Essay draft\nSecond para"})

    def test_minimal_pdf(self):
        r = doctext.run({"kind": "pdf", "data_b64": b64(minimal_pdf(["Assignment spec", "Due Week 5"])), "max_chars": 1000})
        self.assertIn("Assignment spec", r.get("text", ""))
        self.assertIn("Due Week 5", r.get("text", ""))

    def test_max_chars_and_errors(self):
        r = doctext.run({"kind": "docx", "data_b64": b64(minimal_docx(["x" * 500])), "max_chars": 100})
        self.assertEqual(len(r["text"]), 100)
        self.assertEqual(doctext.run({"kind": "pdf", "data_b64": b64(b"not a pdf")}), {"error": "unreadable"})
        self.assertEqual(doctext.run({"kind": "exe", "data_b64": b64(b"x")}), {"error": "bad-input"})
        self.assertEqual(doctext.run({"kind": "pdf", "data_b64": "%%%"}), {"error": "bad-input"})

    def test_never_imports_vault(self):
        doctext.run({"kind": "pdf", "data_b64": b64(minimal_pdf(["x"]))})
        self.assertNotIn("chromadb", sys.modules)
        self.assertNotIn("vault", sys.modules)


if __name__ == "__main__":
    unittest.main()
