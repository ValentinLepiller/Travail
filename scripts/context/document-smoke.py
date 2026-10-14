"""Generate and reopen one harmless PDF using existing local document libraries."""
import argparse
import json
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
args = parser.parse_args()
args.output.parent.mkdir(parents=True, exist_ok=True)
page = canvas.Canvas(str(args.output), pagesize=A4)
page.setTitle("MT local document capability")
page.setFont("Helvetica-Bold", 20)
page.drawString(56, 780, "MT local document capability")
page.setFont("Helvetica", 11)
page.drawString(56, 748, "Non-sensitive fixture generated locally with ReportLab.")
page.drawString(56, 728, "No external account, connector or paid API is required.")
page.showPage()
page.save()
reader = PdfReader(args.output)
assert len(reader.pages) == 1
assert "Non-sensitive fixture" in reader.pages[0].extract_text()
print(json.dumps({"pages": 1, "text_verified": True, "output": str(args.output.resolve())}))
