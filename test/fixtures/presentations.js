// A PowerPoint deck laid out the way PowerPoint saves one: a slide list with
// sections and a custom show, a layout and master with a shared logo, slides
// with their own pictures, speaker notes, review comments and SmartArt, and
// document properties that name every slide. Words that must never reach a
// one-slide share are marked PRIVATE.
import { writeZip } from '../../src/dependencies/zip-archive.js';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.presentationml';

const rels = (entries) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_REL}">${entries.map(([id, type, target, external]) =>
  `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;

const run = (text) => `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${text}</a:t></a:r>`;
const paragraph = (text, { level = 0, bullet = null } = {}) => `<a:p>${level || bullet ? `<a:pPr${level ? ` lvl="${level}"` : ''}>${bullet === false ? '<a:buNone/>' : bullet ? '<a:buChar char="•"/>' : ''}</a:pPr>` : ''}${run(text)}</a:p>`;
const shape = (id, name, placeholder, paragraphs, textBox = false) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${textBox ? ' txBox="1"' : ''}><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${placeholder ?? ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`;
const slide = (shapes, { hidden = false } = {}) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}${hidden ? ' show="0"' : ''}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
const title = (text) => shape(2, 'Title 1', '<p:ph type="title"/>', [paragraph(text)]);
const footer = shape(9, 'Footer 8', '<p:ph type="ftr" sz="quarter" idx="11"/>', [paragraph('Orchard Confidential footer')]);
const picture = (id, rId) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/></p:blipFill><p:spPr/></p:pic>`;
const notes = (slideRel, text) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(3, 'Notes Placeholder 2', '<p:ph type="body" idx="1"/>', [paragraph(text)])}</p:spTree></p:cSld></p:notes>`;

const TABLE = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="10"/><a:gridCol w="10"/><a:gridCol w="10"/></a:tblGrid>${
  [['Team', 'Q3', 'Q4'], ['Engineering', '4', '6'], ['Sales', '2', '3']].map((row) => `<a:tr h="10">${row.map((cell) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph(cell)}</a:txBody><a:tcPr/></a:tc>`).join('')}</a:tr>`).join('')
}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

const SLIDES = [
  slide([shape(2, 'Title 1', '<p:ph type="ctrTitle"/>', [paragraph('Quarterly Business Review')]),
    shape(3, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', [paragraph('Prepared for the Orchard board')]), footer]),
  slide([title('Revenue Growth'),
    shape(3, 'Content Placeholder 2', '<p:ph idx="1"/>', [
      paragraph('Revenue grew 18 percent year over year to 4.2 million dollars.'),
      paragraph('Recurring contracts made up most of the increase.', { level: 1 }),
      paragraph('Churn fell to 3 percent across enterprise accounts.'),
      `<a:p><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rId5" action="ppaction://hlinksldjump"/></a:rPr><a:t>See the hiring plan for open roles.</a:t></a:r></a:p>`,
    ]), picture(5, 'rId3'), footer]),
  slide([title('Hiring Plan'), TABLE,
    shape(5, 'TextBox 4', null, [paragraph('Offers go out after the board approves the budget.')], true)]),
  slide([title('Next Steps'), `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Diagram 2"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId3" r:lo="rId4" r:qs="rId5" r:cs="rId6"/></a:graphicData></a:graphic></p:graphicFrame>`],
  { hidden: true }),
];

const DIAGRAM_DATA = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>
<dgm:pt modelId="{1}" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></dgm:t></dgm:pt>
<dgm:pt modelId="{2}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/>${paragraph('Approve the budget')}</dgm:t></dgm:pt>
<dgm:pt modelId="{3}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/>${paragraph('Open the requisitions')}</dgm:t></dgm:pt>
</dgm:ptLst><dgm:cxnLst/><dgm:bg/><dgm:whole/></dgm:dataModel>`;

const PRESENTATION = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/><p:sldId id="259" r:id="rId5"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:custShowLst><p:custShow name="PRIVATE board cut" id="0"><p:sldLst><p:sld r:id="rId3"/><p:sld r:id="rId4"/></p:sldLst></p:custShow></p:custShowLst><p:defaultTextStyle/><p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="Intro" id="{A}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section><p14:section name="PRIVATE section" id="{B}"><p14:sldIdLst><p14:sldId id="257"/><p14:sldId id="258"/><p14:sldId id="259"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext><p:ext uri="{EFAFB233-063F-42B5-8137-9DF3F51BA10A}"><p15:sldGuideLst xmlns:p15="http://schemas.microsoft.com/office/powerpoint/2012/main"/></p:ext></p:extLst></p:presentation>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>
${[1, 2, 3, 4].map((n) => `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${CT}.slide+xml"/>`).join('')}
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/>
<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.notesMaster+xml"/>
${[2, 3].map((n) => `<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="${CT}.notesSlide+xml"/>`).join('')}
<Override PartName="/ppt/comments/comment1.xml" ContentType="${CT}.comments+xml"/><Override PartName="/ppt/commentAuthors.xml" ContentType="${CT}.commentAuthors+xml"/>
<Override PartName="/ppt/diagrams/data1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="${CT}.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="${CT}.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="${CT}.tableStyles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Quarterly Business Review</dc:title><dc:creator>Dana Lee</dc:creator><cp:lastModifiedBy>PRIVATE editor</cp:lastModifiedBy><dc:description>PRIVATE description</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">2026-09-30T12:00:00Z</dcterms:created></cp:coreProperties>`;

const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Slides>4</Slides><Notes>2</Notes><HiddenSlides>1</HiddenSlides><TitlesOfParts><vt:vector size="4" baseType="lpstr"><vt:lpstr>Quarterly Business Review</vt:lpstr><vt:lpstr>Revenue Growth</vt:lpstr><vt:lpstr>Hiring Plan</vt:lpstr><vt:lpstr>Next Steps</vt:lpstr></vt:vector></TitlesOfParts></Properties>`;

const MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${picture(7, 'rId3')}</p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
const LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS} type="obj"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${title('Click to edit Master title style')}</p:spTree></p:cSld></p:sldLayout>`;
const COMMENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:cmLst ${NS}><p:cm authorId="0" dt="2026-10-01T10:00:00.000" idx="1"><p:pos x="10" y="10"/><p:text>PRIVATE comment: these numbers are preliminary</p:text></p:cm></p:cmLst>`;
const AUTHORS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:cmAuthorLst ${NS}><p:cmAuthor id="0" name="PRIVATE reviewer" initials="PR" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`;
const PRES_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr ${NS}><p:showPr showNarration="1"><p:custShow id="0"/></p:showPr></p:presentationPr>`;
const VIEW_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:outlineViewPr><p:cViewPr><p:scale><a:sx n="33" d="100"/><a:sy n="33" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr><p:sldLst><p:sld r:id="rId1" collapse="1"/></p:sldLst></p:outlineViewPr></p:viewPr>`;

/** The deck as PowerPoint would save it, or with `overrides` replacing or (null) dropping parts. */
export function quarterlyReview(overrides = {}) {
  const parts = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': rels([['rId3', 'extended-properties', 'docProps/app.xml'],
      ['rId2', `${PACKAGE_REL}/metadata/core-properties`, 'docProps/core.xml'],
      ['rId4', `${PACKAGE_REL}/metadata/thumbnail`, 'docProps/thumbnail.jpeg'],
      ['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'docProps/core.xml': CORE,
    'docProps/app.xml': APP,
    'docProps/thumbnail.jpeg': 'PRIVATE thumbnail of the title slide',
    'ppt/presentation.xml': PRESENTATION,
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml'], ['rId4', 'slide', 'slides/slide3.xml'],
      ['rId5', 'slide', 'slides/slide4.xml'], ['rId6', 'notesMaster', 'notesMasters/notesMaster1.xml'],
      ['rId7', 'presProps', 'presProps.xml'], ['rId8', 'viewProps', 'viewProps.xml'], ['rId9', 'theme', 'theme/theme1.xml'],
      ['rId10', 'tableStyles', 'tableStyles.xml'], ['rId11', 'commentAuthors', 'commentAuthors.xml']]),
    'ppt/slides/slide1.xml': SLIDES[0],
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slides/slide2.xml': SLIDES[1],
    'ppt/slides/_rels/slide2.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'notesSlide', '../notesSlides/notesSlide2.xml'], ['rId3', 'image', '../media/image2.png'],
      ['rId4', 'comments', '../comments/comment1.xml'], ['rId5', 'slide', 'slide3.xml'],
      ['rId6', 'hyperlink', 'https://orchard.example/report', true]]),
    'ppt/slides/slide3.xml': SLIDES[2],
    'ppt/slides/_rels/slide3.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'notesSlide', '../notesSlides/notesSlide3.xml'], ['rId3', 'image', '../media/image3.png']]),
    'ppt/slides/slide4.xml': SLIDES[3],
    'ppt/slides/_rels/slide4.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId3', 'diagramData', '../diagrams/data1.xml']]),
    'ppt/diagrams/data1.xml': DIAGRAM_DATA,
    'ppt/notesSlides/notesSlide2.xml': notes('rId1', 'PRIVATE note: do not mention the acquisition'),
    'ppt/notesSlides/_rels/notesSlide2.xml.rels': rels([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'],
      ['rId2', 'slide', '../slides/slide2.xml']]),
    'ppt/notesSlides/notesSlide3.xml': notes('rId1', 'PRIVATE note: layoffs in the first quarter'),
    'ppt/notesSlides/_rels/notesSlide3.xml.rels': rels([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'],
      ['rId2', 'slide', '../slides/slide3.xml']]),
    'ppt/notesMasters/notesMaster1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notesMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:notesMaster>`,
    'ppt/notesMasters/_rels/notesMaster1.xml.rels': rels([['rId1', 'theme', '../theme/theme1.xml']]),
    'ppt/comments/comment1.xml': COMMENTS,
    'ppt/commentAuthors.xml': AUTHORS,
    'ppt/slideMasters/slideMaster1.xml': MASTER,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'], ['rId3', 'image', '../media/image1.png']]),
    'ppt/slideLayouts/slideLayout1.xml': LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements/></a:theme>`,
    'ppt/media/image1.png': 'shared logo',
    'ppt/media/image2.png': 'revenue chart picture',
    'ppt/media/image3.png': 'PRIVATE org chart picture',
    'ppt/presProps.xml': PRES_PROPS,
    'ppt/viewProps.xml': VIEW_PROPS,
    'ppt/tableStyles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    ...overrides,
  };
  return writeZip(Object.entries(parts).filter(([, content]) => content != null)
    .map(([name, content]) => ({ name, content: Buffer.from(content, 'utf8') })));
}
