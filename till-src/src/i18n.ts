/* Bilingual EN / Dhivehi (Thaana, RTL). Dhivehi is a customer- and till-facing
   concern (the admin cockpit stays English-only). Translation is keyed by the
   English source string so call sites read naturally: t("Add to order", lang).
   Any string without a Dhivehi entry falls back to English, so partial coverage
   degrades gracefully rather than showing blanks. */

export type Lang = "en" | "dv";

const DV: Record<string, string> = {
  // guest portal — menu
  "Welcome to": "މަރުހަބާ",
  "Menu": "މެނޫ",
  "Search for a dish…": "ކާނާ ހޯދާ…",
  "Categories": "ބައިތައް",
  "All": "ހުރިހާ",
  "Your Order": "ތިޔަ އޯޑަރު",
  "Sold out": "ހުސްވެއްޖެ",
  "No items in this category.": "މި ބައިގައި އެއްވެސް އެއްޗެއް ނެތް.",
  "Loading menu…": "މެނޫ ލޯޑްވަނީ…",
  "Table": "މޭޒު",
  "Order & pickup": "އޯޑަރ އަދި ޕިކަޕް",
  // guest portal — item detail
  "Add Ons": "އިތުރު ބައިތައް",
  "Free": "ހިލޭ",
  "Notes": "ނޯޓު",
  "e.g. no chili, extra spicy…": "މިސާލު: މިރުސް ނުލާ، ހަވާދު އިތުރު…",
  "Qty": "އަދަދު",
  "Total": "ޖުމްލަ",
  "Add to order": "އޯޑަރަށް އިތުރުކުރޭ",
  // guest portal — summary
  "Your Order Summary": "އޯޑަރުގެ ޚުލާސާ",
  "Your order is empty.": "ތިޔަ އޯޑަރު ހުސް.",
  "Have a Promo Code?": "ޕްރޮމޯ ކޯޑެއް އެބައޮތްތަ؟",
  "Enter": "ޖައްސަވާ",
  "Applied": "ބޭނުންކުރެވިއްޖެ",
  "Payment Summary": "ފައިސާގެ ޚުލާސާ",
  "Subtotal": "ސަބްޓޯޓަލް",
  "Tax & Service": "ޓެކްސް އަދި ސާވިސް",
  "Promo Code (5%)": "ޕްރޮމޯ ކޯޑް (5%)",
  "Total Payment": "ޖުމްލަ ފައިސާ",
  "Order & Pay Now": "އޯޑަރ އަދި ފައިސާ ދައްކަވާ",
  "Order Now": "މިހާރު އޯޑަރުކުރޭ",
  "That promo code isn't valid.": "އެ ޕްރޮމޯ ކޯޑު ސައްޙައެއް ނޫން.",
  // guest portal — confirmation / waiter
  "Order placed": "އޯޑަރު ލިބިއްޖެ",
  "Paid & ordered": "ފައިސާ ދައްކާ އޯޑަރުކުރެވިއްޖެ",
  "Order more": "އިތުރަށް އޯޑަރުކުރޭ",
  "Call waiter": "ވެއިޓަރަށް ގޮވާ",
  "Waiter on the way": "ވެއިޓަރ އަންނަނީ",
  "sent to the kitchen": "ބަދިގެއަށް ފޮނުވިއްޖެ",
  // register — chrome / actions
  "Search or type barcode…": "ހޯދާ ނުވަތަ ބާކޯޑް ޖަހާ…",
  "Scan": "ސްކޭން",
  "Register": "ރަޖިސްޓަރ",
  "Floor": "ފްލޯ",
  "Tables": "މޭޒުތައް",
  "Kitchen": "ބަދިގެ",
  "QR Orders": "ކިއުއާރް އޯޑަރު",
  "Outlets": "ފިހާރަތައް",
  "Delivery": "ޑެލިވަރީ",
  "Dashboard": "ޑޭޝްބޯޑް",
  "Analytics": "އެނަލިޓިކްސް",
  "Inventory": "ސްޓޮކް",
  "Expenses": "ޚަރަދު",
  "Day End": "ދުވަސް ނިމުން",
  "Staff": "މުވައްޒަފުން",
  "Setup": "ސެޓަޕް",
  "Reports": "ރިޕޯޓު",
  "Charge": "ފައިސާ ނަގާ",
  "Hold": "ހިފަހައްޓާ",
  "Clear": "ސާފުކުރޭ",
  "Send to KOT": "ބަދިގެއަށް ފޮނުވާ",
  "Language": "ބަސް",
  "Sign out": "ސައިން އައުޓް",
  "Admin panel": "އެޑްމިން ޕެނަލް",
  "Scan or tap a product to start": "ފެށުމަށް ޕްރޮޑަކްޓެއް ސްކޭން ނުވަތަ ޖައްސަވާ",
  // register — open bills rail
  "Open Bills": "ހުޅުވިފައިވާ ބިލުތައް",
  "New bill": "އައު ބިލު",
  "No open bills. Held and kitchen-fired orders show up here.": "ހުޅުވިފައިވާ ބިލެއް ނެތް. ހިފަހައްޓާފައި އަދި ބަދިގެއަށް ފޮނުވާފައިވާ އޯޑަރުތައް މިތާ ފެންނާނެ.",
  "In progress": "ކުރިއަށްދަނީ",
  "In kitchen": "ބަދިގޭގައި",
  "Ready": "ތައްޔާރު",
  "Served": "ދީފި",
  "Open": "ހުޅުވިފައި",
  "Walk-in": "ވޯކް-އިން",
  // register — order type
  "Dine-In": "ކައިގެން",
  "Takeaway": "ޓޭކްއަވޭ",
  // register — bill canvas
  "Order": "އޯޑަރު",
  "Add customer": "ކަސްޓަމަރ އިތުރުކުރޭ",
  "Select table": "މޭޒު ހޮވާ",
  "Delivery details": "ޑެލިވަރީ ތަފްޞީލު",
  "zone · address": "ސަރަހައްދު · އެޑްރެސް",
  "each": "ފީސްއަކަށް",
  "DISCOUNT": "ޑިސްކައުންޓް",
  "None": "ނެތް",
  "Discount": "ޑިސްކައުންޓް",
  "Value excl. GST": "ޖީއެސްޓީ ނުލައި އަގު",
  "Service charge": "ސާވިސް ޗާޖު",
  "GST": "ޖީއެސްޓީ",
  // register — menu
  "No products yet": "އަދި ޕްރޮޑަކްޓެއް ނެތް",
};

export function t(en: string, lang: Lang): string {
  if (lang === "dv") return DV[en] || en;
  return en;
}
