import test from 'node:test';
import assert from 'node:assert/strict';
import { tableContext } from '../src/dependencies/table-preview.js';
import { buildSharePreview } from '../src/sharing/share-preview.js';

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
