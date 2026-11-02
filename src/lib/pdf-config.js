// Everything on the printable price list that the shop can change. Stored in Firestore: settings/pdf (text)
// and settings/pdfimg-<slot> (replacement images). Defaults reproduce the shop's Diwali 2026 price list.

export const PDF_DEFAULTS = {
  // Note (shown under the section title; left empty = not printed)
  note: '',

  // Page 1 header
  headTitle: 'Best Fire Works',
  headPill: 'Shivakashi Factory Outlet',
  headLine: 'Wholesale & Retail',
  headAccept: 'We Accept All Credit & Debit Cards',
  stickerLabel: 'CALL / WHATSAPP',
  stickerPhone: '88854 56439',

  // Header on later pages, and the footer
  brandName: 'BEST FIRE WORKS',
  brandLine: 'Diwali 2026 Price List  ·  Call / WhatsApp 88854 56439',
  footerText: 'Best Fire Works · Shivakashi Factory Outlet · Wholesale & Retail · Call / WhatsApp 88854 56439',

  // Offer
  offerOn: true,
  offerTop: 'EXTRA',
  offerValue: '10%',
  offerBottom: 'OFF',
  offerCardTitle: 'HURRY! OFFER VALID UP TO',
  offerCardDate: '5th NOV 2026',
  offerCardSub: 'on bills above ₹10,000 (single bill)',
  offerPill: 'OFFER VALID UP TO 5th NOV 2026',
  offerExclusion: '* NA on pop pop, wonder through, guns & ring caps',

  // Sections
  stdLabel: 'SECTION A',
  stdTitle: 'STANDARD FIREWORKS',
  stdSub: 'Diwali 2026',
  stdBar: 'STANDARD BRAND',
  othLabel: 'SECTION B',
  othTitle: 'OTHER BRANDS',
  othSub: 'Diwali 2026',

  // Table column titles
  colProduct: 'PRODUCT',
  colBrand: 'BRAND',
  colBox: 'BOX',
  colPcs: 'PCS',
  colAmount: 'AMOUNT ₹',
  colDiscount: 'DISCOUNT ₹',
  colFinal: 'FINAL AMT ₹',
};

// Admin form layout, in display order.
export const PDF_FORM = [
  {
    title: 'Note on the PDF',
    open: true,
    help: 'Printed in a highlighted strip under each section title. Leave empty to hide it.',
    fields: [{ key: 'note', label: 'Note', placeholder: 'e.g. Prices valid till 8 Nov 2026', max: 110 }],
  },
  {
    title: 'Offer',
    open: true,
    fields: [
      { key: 'offerOn', label: 'Show the offer on the PDF', type: 'check' },
      { key: 'offerCardDate', label: 'Offer date (big text)', max: 22 },
      { key: 'offerCardTitle', label: 'Line above the date', max: 34 },
      { key: 'offerCardSub', label: 'Line below the date', max: 44 },
      { key: 'offerPill', label: 'Offer text in the top bar of later pages', max: 38 },
      { key: 'offerExclusion', label: 'Exclusions (Other Brands section)', max: 70 },
      { key: 'offerTop', label: 'Badge: top word', max: 10 },
      { key: 'offerValue', label: 'Badge: big value', max: 5 },
      { key: 'offerBottom', label: 'Badge: bottom word', max: 8 },
    ],
  },
  {
    title: 'Page 1 header',
    fields: [
      { key: 'headTitle', label: 'Shop name', max: 26 },
      { key: 'headPill', label: 'Pink strip', max: 40 },
      { key: 'headLine', label: 'Green line', max: 34 },
      { key: 'headAccept', label: 'Bottom line', max: 48 },
      { key: 'stickerLabel', label: 'Phone box: label', max: 22 },
      { key: 'stickerPhone', label: 'Phone box: number', max: 18 },
    ],
  },
  {
    title: 'Top bar and footer',
    fields: [
      { key: 'brandName', label: 'Name in the top bar of later pages', max: 26 },
      { key: 'brandLine', label: 'Line under the name', max: 66 },
      { key: 'footerText', label: 'Footer on every page', max: 110 },
    ],
  },
  {
    title: 'Sections',
    fields: [
      { key: 'stdLabel', label: 'Standard: small label', max: 20 },
      { key: 'stdTitle', label: 'Standard: title (two words print on two lines)', max: 30 },
      { key: 'stdSub', label: 'Standard: text after the item count', max: 24 },
      { key: 'stdBar', label: 'Standard: table heading', max: 30 },
      { key: 'othLabel', label: 'Other Brands: small label', max: 20 },
      { key: 'othTitle', label: 'Other Brands: title', max: 30 },
      { key: 'othSub', label: 'Other Brands: text after the item count', max: 24 },
    ],
  },
  {
    title: 'Table column titles',
    fields: [
      { key: 'colProduct', label: 'Product', max: 16 },
      { key: 'colBrand', label: 'Brand', max: 12 },
      { key: 'colBox', label: 'Box', max: 5 },
      { key: 'colPcs', label: 'Pieces', max: 5 },
      { key: 'colAmount', label: 'Amount', max: 12 },
      { key: 'colDiscount', label: 'Discount', max: 12 },
      { key: 'colFinal', label: 'Final amount', max: 13 },
    ],
  },
];

// Header images. `file` is the built-in artwork; slots without one are empty until the shop uploads an image.
export const PDF_IMAGES = [
  { slot: 'extra', label: 'Extra image, far left (e.g. Ganesha)', file: null },
  { slot: 'badge', label: 'Happy Diwali badge', file: '/pdf/header/diwali-badge.png' },
  { slot: 'peacock', label: 'Peacock logo', file: '/pdf/header/peacock.png' },
  { slot: 'standard', label: 'STANDARD wordmark', file: '/pdf/header/standard.png' },
  { slot: 'productsLeft', label: 'Products, bottom left', file: '/pdf/header/products-left.png' },
  { slot: 'productsRight', label: 'Products, bottom right', file: '/pdf/header/products-right.png' },
];
