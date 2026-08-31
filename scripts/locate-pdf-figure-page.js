ObjC.import('Foundation');
ObjC.import('PDFKit');

function run(argv) {
  if (argv.length < 3) throw new Error('Expected input PDF, output PDF, and figure number.');
  const input = $.NSURL.fileURLWithPath(argv[0]);
  const output = $.NSURL.fileURLWithPath(argv[1]);
  const identifier = String(argv[2] || '').trim();
  const document = $.PDFDocument.alloc.initWithURL(input);
  if (!document || Number(document.pageCount) < 1) throw new Error('The PDF could not be opened.');

  const queries = [
    `Figure ${identifier}.`, `Fig. ${identifier}.`,
    `Figure ${identifier}:`, `Fig. ${identifier}:`,
    `Figure ${identifier}`, `Fig. ${identifier}`,
  ];
  let pageIndex = 0;
  let located = false;
  let matchedLabel = '';
  for (const query of queries) {
    const matches = document.findStringWithOptions(query, $.NSCaseInsensitiveSearch);
    if (!matches || Number(matches.count) < 1) continue;
    const selection = matches.objectAtIndex(0);
    const pages = selection.pages;
    if (!pages || Number(pages.count) < 1) continue;
    pageIndex = Number(document.indexForPage(pages.objectAtIndex(0)));
    located = true;
    matchedLabel = query;
    break;
  }

  const page = document.pageAtIndex(pageIndex);
  const selected = $.PDFDocument.alloc.init;
  selected.insertPageAtIndex(page, 0);
  if (!selected.writeToURL(output)) throw new Error('The cited PDF page could not be prepared.');
  return JSON.stringify({ pageNumber: pageIndex + 1, located, matchedLabel });
}
