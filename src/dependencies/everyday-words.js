// Words of everyday writing that, alone, say nothing about which source a
// sentence means: "see you next week" shares "week" with many passages and
// names none of them. One of these summons a passage only together with
// another typed word (show-gate.js). Words that name things kept in work
// folders (revenue, invoice, budget, bracket, patient) are left out on purpose.

export const EVERYDAY_WORDS = new Set(`
able accept add address afternoon again ago agree ahead allow almost alone along already alright always amazing
another answer anyone anything anyway appreciate around arrive ask attach attached away back bad been begin
believe best better big birthday bit book both break bring busy buy call came can care catch chance change chat
check choose clear close come coming confirm cool couple course currently cut day days dear decide definitely
delay did different dinner done doubt down drive drop early easy eat else end enjoy enough even evening ever
every everyone everything exactly excited fact fall family far fast feel few fill finally find fine finish first
follow forget form forward free friday friend from full fun get give glad going gone good got great guess guy
half hand happen happy hard have head hear hello help here hey high hold home hope hour house how huge idea
important instead just keep kind know last late later least leave left let life like likely list little live
long look lot love lunch made mail main make many matter maybe mean meet meeting mention might mind minute miss
moment monday month more morning most move much must name near need never new next nice night nothing notice now
offer often okay old once one only open other out over pass past people perfect person phone pick place play
please point possible pretty probably problem put question quick quite ready real really reason remember reply
rest right run said same saturday say second see seem send sent set several share short should show side simple
since small some someone something soon sorry sort sound speak spend start stay still stop stuff sunday sure
take talk tell terrible thank thanks thing think though thought thursday time today together tomorrow tonight
too top touch train trip true try tuesday turn understand until update use usual wait walk want watch way
weather wednesday week weekend welcome well went whole why wish without wonder word work world worry would write
wrong year yes yesterday yet
`.trim().split(/\s+/));
