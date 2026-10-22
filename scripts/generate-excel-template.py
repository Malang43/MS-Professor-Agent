"""Generate the public synthetic workbook using only Python standard-library ZIP/XML."""
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo
import csv

root = Path(__file__).resolve().parents[1]
columns = ["name", "email", "university", "interests", "subject", "body", "scheduled_at", "timezone", "followup_days", "followup_subject", "followup_body"]
example = ["Synthetic Professor", "controlled@example.com", "Example University", "Robotics and machine learning", "MS research inquiry - sample only", "Dear Professor,\nThis is synthetic sample content. Replace and review before approving.", "2099-01-01T12:00:00Z", "Asia/Karachi", "3", "Follow-up - sample only", "Dear Professor,\nFollowing up on my research inquiry. Thank you for your time."]
notes = [
    ["Instructions"],
    ["All example data is synthetic. No real professor is included."],
    ["Import in Professors; check Also prepare fully specified manual mock drafts for email fields."],
    ["Professor-only imports allow 500 rows; complete draft imports allow 25 rows and 5 MB."],
    ["scheduled_at must be UTC ISO TEXT, for example 2099-01-01T12:00:00Z. Do not use an Excel date cell."],
    ["timezone is an IANA display timezone; it does not change the UTC timestamp."],
    ["interests contains professor research details. Subject/body support multiline text."],
    ["followup_days is optional, integer 1-30 elapsed days after confirmed delivery; 3 is supported."],
    ["Provide all three followup columns together, or leave all three blank."],
    ["Follow-ups import as INACTIVE proposals. Spreadsheet authorization columns are ignored."],
    ["Review a proposal and use the composer to select a mailbox and explicitly authorize exact follow-up content."],
    ["Import never approves or sends. Batch approval of a mock draft does not enable live delivery or follow-ups."],
    ["Live sending is disabled pending separate authorization of a controlled recipient test."],
    ["Replies, declines, opt-outs and bounces stop tracked pending follow-ups. Reply access is required."],
    ["Retries skip matching recipient/content/UTC schedule; import errors save no professors or drafts."],
]
def sheet(rows):
    xml = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    for n, row in enumerate(rows, 1):
        xml += f'<row r="{n}">'
        for i, value in enumerate(row):
            ref = chr(65 + i) + str(n)
            xml += f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>'
        xml += '</row>'
    return xml + '</sheetData></worksheet>'
parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Professors" sheetId="1" r:id="rId1"/><sheet name="Instructions" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet([columns, example]),
    'xl/worksheets/sheet2.xml': sheet(notes),
}
with ZipFile(root / 'apps/web/public/professors-email-template.xlsx', 'w', ZIP_DEFLATED) as archive:
    for name, body in parts.items():
        info = ZipInfo(name, (2026, 10, 22, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body)
with (root / 'apps/web/public/professors-email-template.csv').open('w', newline='', encoding='utf-8') as output:
    writer = csv.writer(output)
    writer.writerows([columns, example])
