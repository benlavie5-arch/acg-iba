Study materials go here.

Drop a PDF in this folder, then add one entry to data/materials.json under the
matching competency key. The coursework page picks it up automatically.

Example:
  1. Save the deck as   files/accounting-three-statements.pdf
  2. In data/materials.json, under "accounting", add:

       {
         "title": "Three-statement linkage",
         "file":  "files/accounting-three-statements.pdf",
         "kind":  "Slides",
         "note":  "How the statements connect, worked end to end",
         "pages": 32
       }

Competency keys (must match exactly):
  accounting, corpfin, bonds, lbo, mna, dcf, ev, valuation,
  speaking, stories, market

Notes:
  - PDFs open in the browser's own viewer, so members can read them in place.
  - Keep files under ~10MB each. GitHub repos have a 100MB per-file hard limit.
  - Anything in this folder is publicly downloadable by direct URL, access code
    or not. Do not upload licensed guides or anything you do not have the right
    to distribute.
