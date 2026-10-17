import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Original fictional drawing for software tests. All coordinates are millimetres.
// Room polygons describe clear floor areas. Decorative objects deliberately use
// lines, arcs and circles so they cannot become accidental room measurements.
export const architectureFixtureRooms = [
  { handle: 'A101', name: 'KITCHEN / DINING 101', bounds: [200, 200, 4800, 4400], label: [2500, 3050], area: 19.32 },
  { handle: 'A102', name: 'ENTRY / HALL 102', bounds: [4950, 200, 7050, 8800], label: [6000, 3800], area: 18.06 },
  { handle: 'A103', name: 'LIVING ROOM 103', bounds: [7200, 200, 11800, 4400], label: [9500, 3600], area: 19.32 },
  { handle: 'A104', name: 'STUDY 104', bounds: [200, 4550, 4800, 8800], label: [2800, 6900], area: 19.55 },
  { handle: 'A105', name: 'BATHROOM 105', bounds: [7200, 4550, 11800, 6500], label: [9600, 6100], area: 8.97 },
  { handle: 'A106', name: 'BEDROOM 106', bounds: [7200, 6650, 11800, 8800], label: [10450, 7000], area: 9.89 },
];

export function createArchitectureDxfFixture() {
  const records = [];
  let nextHandle = 0x1000;
  const pair = (code, value) => records.push(String(code), String(value));
  const entity = (type, layer, groups, handle = (nextHandle++).toString(16).toUpperCase()) => {
    pair(0, type); pair(5, handle); pair(100, 'AcDbEntity'); pair(8, layer);
    for (const [code, value] of groups) pair(code, value);
    return handle;
  };
  const point = (x, y, base = 10) => [[base, x], [base + 10, y], [base + 20, 0]];
  const line = (x1, y1, x2, y2, layer = 'FURNITURE') => entity('LINE', layer, [[100, 'AcDbLine'], ...point(x1, y1), ...point(x2, y2, 11)]);
  const rect = (x, y, w, h, layer = 'FURNITURE') => {
    line(x, y, x + w, y, layer); line(x + w, y, x + w, y + h, layer);
    line(x + w, y + h, x, y + h, layer); line(x, y + h, x, y, layer);
  };
  const arc = (x, y, radius, start, end, layer = 'DOORS') => entity('ARC', layer,
    [[100, 'AcDbCircle'], ...point(x, y), [40, radius], [100, 'AcDbArc'], [50, start], [51, end]]);
  const circle = (x, y, radius, layer = 'FURNITURE') => entity('CIRCLE', layer, [[100, 'AcDbCircle'], ...point(x, y), [40, radius]]);
  const text = (value, x, y, height = 180, layer = 'ANNOTATIONS', rotation = 0) => entity('TEXT', layer,
    [[100, 'AcDbText'], ...point(x, y), [40, height], [1, value], [50, rotation], [7, 'STANDARD'], [100, 'AcDbText']]);
  const insert = (name, x, y, { scaleX = 1, scaleY = 1, rotation = 0, layer = 'FURNITURE' } = {}) => entity('INSERT', layer,
    [[100, 'AcDbBlockReference'], [2, name], ...point(x, y), [41, scaleX], [42, scaleY], [43, 1], [50, rotation]]);
  const block = (name, draw) => {
    entity('BLOCK', '0', [[100, 'AcDbBlockBegin'], [2, name], [70, name.startsWith('*') ? 1 : 0], ...point(0, 0), [3, name], [1, '']]);
    draw();
    entity('ENDBLK', '0', [[100, 'AcDbBlockEnd']]);
  };

  pair(999, 'Lasso fictional architectural software-test fixture; not for construction.');
  pair(0, 'SECTION'); pair(2, 'HEADER');
  pair(9, '$ACADVER'); pair(1, 'AC1027');
  pair(9, '$INSUNITS'); pair(70, 4);
  pair(9, '$MEASUREMENT'); pair(70, 1);
  pair(9, '$LUNITS'); pair(70, 2);
  pair(9, '$EXTMIN'); for (const [code, value] of point(-1500, -2900)) pair(code, value);
  pair(9, '$EXTMAX'); for (const [code, value] of point(14500, 10200)) pair(code, value);
  pair(0, 'ENDSEC');
  pair(0, 'SECTION'); pair(2, 'TABLES');
  pair(0, 'TABLE'); pair(2, 'LTYPE'); pair(70, 1);
  pair(0, 'LTYPE'); pair(2, 'CONTINUOUS'); pair(70, 0); pair(3, 'Solid line'); pair(72, 65); pair(73, 0); pair(40, 0);
  pair(0, 'ENDTAB');
  pair(0, 'TABLE'); pair(2, 'LAYER'); pair(70, 10);
  for (const [name, color, weight] of [['0', 7, 25], ['WALLS', 7, 50], ['DOORS', 30, 25], ['WINDOWS', 4, 25],
    ['FURNITURE', 8, 18], ['FIXTURES', 8, 18], ['ROOM_AREAS', 3, 9], ['ROOM_NAMES', 7, 18], ['DIMENSIONS', 8, 13], ['ANNOTATIONS', 7, 18]]) {
    pair(0, 'LAYER'); pair(2, name); pair(70, 0); pair(62, color); pair(6, 'CONTINUOUS'); pair(370, weight);
  }
  pair(0, 'ENDTAB');
  pair(0, 'TABLE'); pair(2, 'STYLE'); pair(70, 1);
  pair(0, 'STYLE'); pair(2, 'STANDARD'); pair(70, 0); pair(40, 0); pair(41, 1); pair(50, 0); pair(71, 0); pair(42, 180); pair(3, 'txt'); pair(4, '');
  pair(0, 'ENDTAB'); pair(0, 'ENDSEC');

  pair(0, 'SECTION'); pair(2, 'BLOCKS');
  block('SOFA', () => {
    rect(0, 0, 2400, 950); rect(140, 120, 2120, 650); line(850, 120, 850, 770); line(1550, 120, 1550, 770);
    line(140, 820, 2260, 820);
  });
  block('ARMCHAIR', () => { rect(0, 0, 850, 850); rect(120, 120, 610, 550); line(120, 720, 730, 720); });
  block('DINING_SET', () => {
    rect(0, 0, 1800, 850);
    for (const x of [250, 1150]) { rect(x, -450, 400, 400); rect(x, 900, 400, 400); }
    rect(-450, 225, 400, 400); rect(1850, 225, 400, 400);
  });
  block('DESK', () => { rect(0, 0, 1800, 750); rect(650, 200, 500, 300); line(900, 200, 900, 120); circle(900, -450, 300); });
  block('BED', () => { rect(0, 0, 1500, 2000); rect(80, 80, 600, 400); rect(820, 80, 600, 400); line(0, 620, 1500, 620); });
  block('COFFEE_TABLE', () => { rect(0, 0, 1200, 600); circle(930, 300, 110); });
  block('KITCHEN_COUNTER', () => {
    rect(0, 0, 4000, 600, 'FIXTURES');
    for (const x of [800, 1600, 2400, 3200]) line(x, 0, x, 600, 'FIXTURES');
    rect(150, 120, 500, 360, 'FIXTURES'); circle(400, 300, 45, 'FIXTURES');
    for (const x of [2700, 3050]) for (const y of [180, 420]) circle(x, y, 95, 'FIXTURES');
  });
  block('WC', () => { rect(0, 0, 500, 220, 'FIXTURES'); arc(250, 420, 230, 180, 360, 'FIXTURES'); line(20, 220, 20, 420, 'FIXTURES'); line(480, 220, 480, 420, 'FIXTURES'); circle(250, 430, 145, 'FIXTURES'); });
  block('BASIN', () => { rect(0, 0, 1000, 550, 'FIXTURES'); circle(500, 275, 185, 'FIXTURES'); circle(500, 490, 30, 'FIXTURES'); });
  block('SHOWER', () => { rect(0, 0, 1000, 1000, 'FIXTURES'); line(0, 0, 1000, 1000, 'FIXTURES'); line(1000, 0, 0, 1000, 'FIXTURES'); circle(500, 500, 70, 'FIXTURES'); });
  block('WINDOW_1000', () => { for (const y of [0, 70, 130, 200]) line(0, y, 1000, y, 'WINDOWS'); line(0, 0, 0, 200, 'WINDOWS'); line(1000, 0, 1000, 200, 'WINDOWS'); });
  const dimensionGraphics = (name, x1, y1, x2, y2, dimension, vertical = false) => block(name, () => {
    if (vertical) {
      line(x1 - 150, y1, x1 + 1350, y1, 'DIMENSIONS'); line(x2 - 150, y2, x2 + 1350, y2, 'DIMENSIONS');
      line(x1 + 1200, y1, x2 + 1200, y2, 'DIMENSIONS');
      for (const [x, y, sign] of [[x1 + 1200, y1, 1], [x2 + 1200, y2, -1]]) {
        line(x, y, x - 60, y + sign * 180, 'DIMENSIONS'); line(x, y, x + 60, y + sign * 180, 'DIMENSIONS');
      }
      text(dimension, x1 + 1120, (y1 + y2) / 2 - 350, 160, 'DIMENSIONS', 90);
    } else {
      line(x1, y1 + 150, x1, y1 - 950, 'DIMENSIONS'); line(x2, y2 + 150, x2, y2 - 950, 'DIMENSIONS');
      line(x1, y1 - 800, x2, y2 - 800, 'DIMENSIONS');
      for (const [x, y, sign] of [[x1, y1 - 800, 1], [x2, y2 - 800, -1]]) {
        line(x, y, x + sign * 180, y - 60, 'DIMENSIONS'); line(x, y, x + sign * 180, y + 60, 'DIMENSIONS');
      }
      text(dimension, (x1 + x2) / 2 - 350, y1 - 700, 160, 'DIMENSIONS');
    }
  });
  dimensionGraphics('*D1', 0, 0, 12000, 0, '12000');
  dimensionGraphics('*D2', 12000, 0, 12000, 9000, '9000', true);
  pair(0, 'ENDSEC');

  pair(0, 'SECTION'); pair(2, 'ENTITIES');
  for (const { handle, name, bounds: [x1, y1, x2, y2], label: [lx, ly] } of architectureFixtureRooms) {
    entity('LWPOLYLINE', 'ROOM_AREAS', [[100, 'AcDbPolyline'], [90, 4], [70, 1], [38, 0], [10, x1], [20, y1], [10, x2], [20, y1], [10, x2], [20, y2], [10, x1], [20, y2]], handle);
    // Exactly one model-space alphabetic label inside each measured boundary.
    const labelHeight = handle === 'A102' ? 145 : 170;
    text(name, lx - name.length * labelHeight * 0.27, ly, labelHeight, 'ROOM_NAMES');
  }

  // Exterior walls: two faces with actual gaps for windows and the entrance.
  const horizontalWall = (y1, y2, start, end, gaps) => {
    let cursor = start;
    for (const [a, b] of [...gaps, [end, end]]) {
      if (a > cursor) { line(cursor, y1, a, y1, 'WALLS'); line(cursor, y2, a, y2, 'WALLS'); }
      if (a !== end) { line(a, y1, a, y2, 'WALLS'); line(b, y1, b, y2, 'WALLS'); }
      cursor = b;
    }
  };
  const verticalWall = (x1, x2, start, end, gaps) => {
    let cursor = start;
    for (const [a, b] of [...gaps, [end, end]]) {
      if (a > cursor) { line(x1, cursor, x1, a, 'WALLS'); line(x2, cursor, x2, a, 'WALLS'); }
      if (a !== end) { line(x1, a, x2, a, 'WALLS'); line(x1, b, x2, b, 'WALLS'); }
      cursor = b;
    }
  };
  horizontalWall(0, 200, 0, 12000, [[1300, 3700], [5350, 6350], [8300, 10700]]);
  horizontalWall(8800, 9000, 0, 12000, [[1300, 3700], [8300, 10700]]);
  verticalWall(0, 200, 0, 9000, [[1600, 3000]]);
  verticalWall(11800, 12000, 0, 9000, [[1400, 3200], [4800, 6000]]);
  verticalWall(4800, 4950, 200, 8800, [[1500, 2400], [5400, 6300]]);
  verticalWall(7050, 7200, 200, 8800, [[1500, 2400], [5000, 5900], [7000, 7900]]);
  horizontalWall(4400, 4550, 200, 4800, []);
  horizontalWall(4400, 4550, 7200, 11800, []);
  horizontalWall(6500, 6650, 7200, 11800, []);

  for (const y of [1500, 5400]) {
    line(4800, y + 900, 3900, y + 900, 'DOORS'); arc(4800, y + 900, 900, 180, 270);
  }
  for (const y of [1500, 5000, 7000]) {
    line(7200, y, 8100, y, 'DOORS'); arc(7200, y, 900, 0, 90);
  }
  line(5350, 200, 5350, 1200, 'DOORS'); arc(5350, 200, 1000, 0, 90);
  for (const [x, y, width, rotation] of [[1300, 0, 2400, 0], [8300, 0, 2400, 0], [1300, 8800, 2400, 0],
    [8300, 8800, 2400, 0], [200, 1600, 1400, 90], [12000, 1400, 1800, 90], [12000, 4800, 1200, 90]]) {
    insert('WINDOW_1000', x, y, { scaleX: width / 1000, rotation, layer: 'WINDOWS' });
  }

  insert('KITCHEN_COUNTER', 450, 3700, { layer: 'FIXTURES' });
  insert('DINING_SET', 1500, 1300);
  insert('SOFA', 8050, 650);
  insert('COFFEE_TABLE', 8650, 2250, { scaleX: 0.9, scaleY: 0.9 });
  insert('ARMCHAIR', 11400, 2850, { rotation: 180, scaleX: 0.85, scaleY: 0.85 });
  insert('DESK', 4200, 8200, { rotation: 180 });
  insert('DESK', 1000, 5000, { rotation: 90, scaleX: 0.85, scaleY: 0.85 });
  insert('BED', 9200, 8650, { rotation: 180 });
  insert('WC', 7800, 6400, { rotation: 180, layer: 'FIXTURES' });
  insert('BASIN', 9000, 4650, { layer: 'FIXTURES' });
  insert('SHOWER', 10600, 4650, { layer: 'FIXTURES' });
  // Entry console and bedroom wardrobe, drawn as linework rather than areas.
  rect(6550, 2500, 400, 1400); rect(10600, 8100, 1100, 550);
  line(11150, 8100, 11150, 8650);

  // Real DIMENSION entities use anonymous blocks for their displayed graphics.
  entity('DIMENSION', 'DIMENSIONS', [[100, 'AcDbDimension'], [2, '*D1'], ...point(0, -800), ...point(6000, -700, 11), [70, 32], [1, '<>'], [3, 'STANDARD'], [100, 'AcDbAlignedDimension'], ...point(0, 0, 13), ...point(12000, 0, 14), [100, 'AcDbRotatedDimension'], [50, 0]]);
  entity('DIMENSION', 'DIMENSIONS', [[100, 'AcDbDimension'], [2, '*D2'], ...point(13200, 0), ...point(13120, 4500, 11), [70, 32], [1, '<>'], [3, 'STANDARD'], [100, 'AcDbAlignedDimension'], ...point(12000, 0, 13), ...point(12000, 9000, 14), [100, 'AcDbRotatedDimension'], [50, 90]]);

  // North arrow and title block stay outside measured rooms.
  line(13800, 7400, 13800, 8500, 'ANNOTATIONS');
  line(13800, 8500, 13650, 8100, 'ANNOTATIONS'); line(13800, 8500, 13950, 8100, 'ANNOTATIONS');
  text('N', 13710, 8700, 260);
  rect(0, -2700, 12000, 1100, 'ANNOTATIONS'); line(9000, -2700, 9000, -1600, 'ANNOTATIONS');
  text('CEDAR LANE STUDIO RESIDENCE', 250, -1960, 260);
  text('FICTIONAL SOFTWARE TEST DRAWING - NOT FOR CONSTRUCTION', 250, -2350, 170);
  text('GROUND FLOOR PLAN', 9200, -1900, 155); text('A-101  |  REV 03', 9200, -2240, 155);
  text('UNITS: MILLIMETRES', 9200, -2520, 130);
  text('12 m x 9 m fictional layout; six measured room boundaries on ROOM_AREAS.', 0, 9650, 160);
  pair(0, 'ENDSEC'); pair(0, 'EOF');
  return `${records.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ? path.resolve(process.argv[2])
    : fileURLToPath(new URL('../test/fixtures/drawings/cedar-lane-residence-realistic.dxf', import.meta.url));
  await writeFile(destination, createArchitectureDxfFixture(), 'utf8');
  console.log(`Wrote fictional architectural test drawing: ${destination}`);
}
