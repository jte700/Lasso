import test from 'node:test';
import assert from 'node:assert/strict';
import { tableContext } from '../src/dependencies/table-preview.js';
import { buildInspectorPreview, buildSharePreview } from '../src/sharing/share-preview.js';

test('CSV context retains headings away from the cited row', () => {
 const preview=buildSharePreview({path:'accounts.csv',content:Buffer.from('Account,Amount\na,1\nb,2\nc,3\nd,4\ne,5')},{rowIndex:5,columnIndex:1});
 assert.deepEqual(preview.headers,['Account','Amount']);
 assert.equal(preview.rows.at(-1).cells[1].cited,true);
});
test('merged parent headings combine with local labels and retain physical coordinates',()=>{
 const preview=tableContext({rows:[['Annual report'],['','2025','','2026'],['Account','Actual','Budget','Actual','Budget'],['Rent',10,12,14,16]],rowNumbers:[20,22,23,24],merges:[{firstRow:20,lastRow:20,firstColumn:0,lastColumn:4},{firstRow:22,lastRow:22,firstColumn:1,lastColumn:2},{firstRow:22,lastRow:22,firstColumn:3,lastColumn:4}]},{rowIndex:3,columnIndex:4});
 assert.deepEqual(preview.headers,['Account','2025 · Actual','2025 · Budget','2026 · Actual','2026 · Budget']);
 assert.equal(preview.rows[0].rowNumber,24);
 assert.equal(preview.rows[0].cells[4].cited,true);
});
test('independent table after a worksheet gap uses its own headings',()=>{
 const preview=tableContext({rows:[['Item','Amount'],['A',1],['Metric','Units'],['B',9]],rowNumbers:[1,2,40,41]},{rowIndex:3,columnIndex:1});
 assert.deepEqual(preview.headers,['Metric','Units']);
});
test('Excel table metadata scopes side-by-side tables and keeps sparse columns',()=>{
 const preview=tableContext({rows:[['Other','','','Label','','Total'],['x','','','Income','',100]],rowNumbers:[50,51],tables:[{firstRow:50,lastRow:80,firstColumn:3,lastColumn:5,headerRowCount:1,headers:['Label','Notes','Total']}]},{rowIndex:1,columnIndex:5});
 assert.deepEqual(preview.columns,['D','E','F']);
 assert.deepEqual(preview.headers,['Label','Notes','Total']);
 assert.equal(preview.rows[0].cells[2].cited,true);
});
test('headerless numeric data does not invent semantic headings',()=>{
 const preview=tableContext({rows:[[1,2],[3,4],[5,6]]},{rowIndex:2,columnIndex:1});
 assert.deepEqual(preview.headers,['','']);
 assert.equal(preview.rows.length,3);
});
test('text-only tables use the first heading row, not a nearby data row',()=>{
 const preview=tableContext({rows:[['City','Country'],['Paris','France'],['Rome','Italy'],['Berlin','Germany']]},{rowIndex:3,columnIndex:1});
 assert.deepEqual(preview.headers,['City','Country']);
});
test('wide worksheets preserve referenced column letter',()=>{
 const headers=Array.from({length:28},(_,i)=>`Field ${i+1}`);
 const preview=tableContext({rows:[headers,headers.map(()=>42)]},{rowIndex:1,columnIndex:27});
 assert.equal(preview.columns.at(-1),'AB');
 assert.equal(preview.rows[0].cells.at(-1).cited,true);
});

test('financial statement headers carry across blank rows and section titles',()=>{
 const preview=tableContext({rows:[['Company'],['Income Statement'],['', 'Current Period','','Prior Period','','Increase (Decrease)'],['','07/01/15 to 09/30/15','','07/01/14 to 09/30/14'],['REVENUES'],['Sales',14000,'',11689,'',2311],['COST OF GOODS SOLD'],['Supplies',400,'',310,'',90]],rowNumbers:[4,5,8,9,10,11,17,24]},{rowIndex:7,columnIndex:3});
 assert.deepEqual(preview.headers,['','Current Period','Prior Period','Increase (Decrease)']);
 assert.deepEqual(preview.columns,['A','B','D','F']);
 assert.equal(preview.rows.at(-1).cells[2].cited,true);
});

test('column citations highlight their data instead of an empty total-row cell', () => {
 const file={path:'accounts.csv',content:Buffer.from('Supplier,Invoice,Amount\nNorth,BILL-1,10\nSouth,BILL-2,20\nTOTAL,,30')};
 const anchor={kind:'table-column',column:'Invoice',columnIndex:1};
 const preview=buildSharePreview(file,anchor);
 assert.deepEqual(preview.headers,['Supplier','Invoice','Amount']);
 assert.deepEqual(preview.rows.filter(row=>row.cells[1].cited).map(row=>row.cells[1].value),['BILL-1','BILL-2']);
 assert.equal(preview.rows.at(-1).cells[1].cited,false);
 const inspector=buildInspectorPreview(file,anchor);
 assert.equal(inspector.location,'Column B (all values)');
 assert.equal(inspector.rows[0].cells[1].value,'Invoice');
 assert.equal(inspector.rows.at(-1).cells[1].cited,false);
});

test('inspector viewport preserves original row numbers, spacer columns and cell text', () => {
 const preview=buildInspectorPreview({path:'source.csv',content:Buffer.from('Account,,Amount\nOffice supplies,,"  400.00 "\nPayroll,,225')},{kind:'table-cell',rowIndex:1,columnIndex:2});
 assert.equal(preview.kind,'table');
 assert.deepEqual(preview.columns,['A','B','C']);
 assert.deepEqual(preview.rows.map(row=>row.rowNumber),[1,2,3]);
 assert.equal(preview.rows[1].cells[1].value,'');
 assert.equal(preview.rows[1].cells[2].value,'  400.00 ');
 assert.equal(preview.rows[1].cells[2].cited,true);
 assert.equal(preview.location,'C2');
});

test('local variable previews cite the physical column header without changing public column scope', () => {
 const file={path:'Department-Budgets.csv',content:Buffer.from([
  ',,Department Budgets', ',,September 2026', '', '', '',
  ',,Department,Actual,Budget', ',,People,76000,74000', ',,Facilities,21100,21000',
  ',,Marketing,14000,16000', ',,Total operating expenses,111100,111000',
 ].join('\n'))};
 const anchor={kind:'table-column',column:'Department',columnIndex:2};
 const metadata={variable:'Department',dictionary:false};
 const citedCells=preview=>preview.rows.flatMap(row=>row.cells.flatMap((cell,index)=>
  cell.cited ? [`${preview.columns[index]}${row.rowNumber}:${cell.value}`] : []));
 const inspector=buildInspectorPreview(file,anchor,metadata,'Department','VARIABLE');
 assert.equal(inspector.location,'C6 (column header)');
 assert.deepEqual(citedCells(inspector),['C6:Department']);
 assert.ok(inspector.rows.some(row=>row.cells.some(cell=>cell.value==='Marketing')));
 const suggestion=buildSharePreview(file,anchor,metadata,2,'VARIABLE');
 assert.equal(suggestion.location,'C6 (column header)');
 assert.deepEqual(citedCells(suggestion),['C6:Department']);
 assert.equal(suggestion.columnCitation,false);
 const shared=buildSharePreview(file,anchor,metadata);
 assert.equal(shared.columnCitation,true);
 assert.deepEqual(citedCells(shared),['C7:People','C8:Facilities','C9:Marketing']);
 assert.deepEqual(anchor,{kind:'table-column',column:'Department',columnIndex:2});
});

test('local row labels and numeric values cite their own cell, retaining surrounding context', () => {
 const file={path:'accounts.csv',content:Buffer.from('Department,Actual,Budget\nPeople,76000,74000\nMarketing,14000,16000')};
 const rowAnchor={kind:'table-row',rowIndex:2,rowKey:'Marketing'};
 const row=buildInspectorPreview(file,rowAnchor,{},'Marketing','DATASET_ROW');
 assert.equal(row.location,'A3');
 assert.deepEqual(row.rows.flatMap(row=>row.cells.filter(cell=>cell.cited).map(cell=>cell.value)),['Marketing']);
 const suggestion=buildSharePreview(file,rowAnchor,{},2,'DATASET_ROW');
 assert.deepEqual(suggestion.rows.flatMap(row=>row.cells.filter(cell=>cell.cited).map(cell=>cell.value)),['Marketing']);
 const value=buildInspectorPreview(file,{kind:'table-cell',rowIndex:2,rowKey:'Marketing',columnIndex:1},{},'Marketing · Actual','DATASET_VALUE');
 assert.equal(value.location,'B3');
 assert.deepEqual(value.rows.flatMap(row=>row.cells.filter(cell=>cell.cited).map(cell=>cell.value)),['14000']);
 const shared=buildSharePreview(file,rowAnchor);
 assert.deepEqual(shared.rows.flatMap(row=>row.cells.filter(cell=>cell.cited).map(cell=>cell.value)),['Marketing','14000','16000']);
});

test('text inspector reads source lines with their original spacing', () => {
 const preview=buildInspectorPreview({path:'analysis.py',content:Buffer.from('def run():\n    result = 400\n    return result\n')},{lineStart:2,lineEnd:2});
 assert.equal(preview.kind,'text');
 assert.equal(preview.lines[1].value,'    result = 400');
 assert.equal(preview.lines[1].lineNumber,2);
 assert.equal(preview.lines[1].cited,true);
 assert.equal(preview.lines[2].cited,false);
});
