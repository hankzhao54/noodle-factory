// Legal texts for the ordering site. Hungarian is the binding version; English is a courtesy translation.
// Company data comes from the back office (noodle.public_info); missing values show as "…".
// Each document: { title, intro?, sections: [{ h, p: [string | string[] (bullet list)] }] }

const v = x => (x && String(x).trim()) || '…'
const SITE = 'https://noodle.101bistro.hu'

const HOSTING = {
  name: 'Vercel Inc.',
  address: '440 N Barranca Avenue #4133, Covina, CA 91723, USA',
  web: 'vercel.com',
}

function company(i, lang) {
  const hu = lang === 'hu'
  return [
    `${hu ? 'Cégnév' : 'Company name'}: ${v(i.company_name)}`,
    `${hu ? 'Székhely' : 'Registered office'}: ${v(i.company_address)}`,
    `${hu ? 'Cégjegyzékszám' : 'Company registration number'}: ${v(i.company_reg_no)}`,
    `${hu ? 'Nyilvántartó cégbíróság' : 'Registry court'}: ${v(i.company_court)}`,
    `${hu ? 'Adószám' : 'Tax number'}: ${v(i.company_tax_no)}`,
    `E-mail: ${v(i.company_email)}`,
    i.company_phone ? `${hu ? 'Telefon' : 'Phone'}: ${i.company_phone}` : null,
    i.company_authority ? `${hu ? 'Élelmiszerlánc-felügyeleti hatóság / nyilvántartási szám' : 'Food-chain supervisory authority / registration'}: ${i.company_authority}` : null,
  ].filter(Boolean)
}

export function impresszum(i, lang) {
  if (lang === 'hu') return {
    title: 'Impresszum',
    intro: `A ${SITE} oldalt üzemeltető szolgáltató adatai (az elektronikus kereskedelmi szolgáltatásokról szóló 2001. évi CVIII. törvény 4. §-a alapján).`,
    sections: [
      { h: 'Szolgáltató', p: [company(i, 'hu')] },
      { h: 'Tárhelyszolgáltató', p: [[`${HOSTING.name}`, HOSTING.address, HOSTING.web]] },
      { h: 'Adatbázis és e-mail küldés', p: ['Az adatbázist a Supabase, Inc. (supabase.com) az Európai Unióban (Írország) üzemelteti; a rendelési e-maileket a Resend (resend.com) küldi.'] },
    ],
  }
  return {
    title: 'Legal notice',
    intro: `Details of the operator of ${SITE} (Hungarian Act CVIII of 2001, Section 4).`,
    sections: [
      { h: 'Operator', p: [company(i, 'en')] },
      { h: 'Hosting provider', p: [[`${HOSTING.name}`, HOSTING.address, HOSTING.web]] },
      { h: 'Database and e-mail', p: ['The database is operated by Supabase, Inc. (supabase.com) in the European Union (Ireland); order e-mails are sent by Resend (resend.com).'] },
    ],
  }
}

export function aszf(i, lang) {
  const cut = i.order_cutoff_time || '14:00'
  const lead = i.order_lead_days || '1'
  if (lang === 'hu') return {
    title: 'Általános Szerződési Feltételek (vállalkozások részére)',
    intro: `Hatályos: ${v(i.terms_version)}. Jelen feltételek a ${v(i.company_name)} (a továbbiakban: Gyártó) és a ${SITE} rendelési felületen rendelő vállalkozások (a továbbiakban: Ügyfél) közötti szerződésekre vonatkoznak.`,
    sections: [
      { h: '1. A Gyártó adatai', p: [company(i, 'hu')] },
      { h: '2. Hatály, kizárólag vállalkozások részére', p: [
        'A rendelési felület kizárólag vállalkozások (pl. éttermek, vendéglátóhelyek, kereskedők) számára érhető el. Fogyasztók (a Ptk. 8:1. § (1) 3. pontja szerinti természetes személyek) részére a Gyártó a felületen nem értékesít, ezért a fogyasztói szerződésekre vonatkozó szabályok (pl. 14 napos elállási jog) nem alkalmazandók.',
        'A szerződésekre a magyar jog, különösen a Polgári Törvénykönyvről szóló 2013. évi V. törvény (Ptk.) irányadó. Az Ügyfél saját általános szerződési feltételei csak akkor válnak a szerződés részévé, ha azokat a Gyártó írásban kifejezetten elfogadja.',
      ] },
      { h: '3. Hozzáférés', p: [
        'A felületre a Gyártó által jóváhagyott felhasználók léphetnek be. A felhasználó a belépési adatait köteles titokban tartani; a fiókjával leadott rendeléseket az Ügyfél rendeléseinek kell tekinteni.',
        'Jelen feltételeket az Ügyfél a regisztrációkor, illetve az első rendelés előtt elfogadja. Módosítás esetén az új változatot a következő rendelés előtt kell elfogadni.',
      ] },
      { h: '4. Termékek és termékinformáció', p: [
        'A Gyártó frissen készült tésztatermékeket forgalmaz. Az összetevők, az allergének (vastagon kiemelve), a nettó mennyiség, a tárolási feltételek és a minőségmegőrzési / fogyaszthatósági idő a rendelési felületen a termék „Termékinformáció” részében, valamint a termék címkéjén és a szállítólevélen szerepelnek.',
        'A termékfotók illusztrációk.',
      ] },
      { h: '5. Árak', p: [
        'A felületen és a visszaigazolásokban szereplő árak nettó árak forintban, amelyeket a mindenkor hatályos általános forgalmi adó terhel.',
        'Az Ügyfél részére egyedi árak is megállapíthatók. A rendelésre a rendelés leadásakor a felületen megjelenített ár érvényes; a későbbi árváltozás a már leadott rendelést nem érinti.',
      ] },
      { h: '6. A rendelés menete, a szerződés létrejötte', p: [
        'Az Ügyfél a felületen kiválasztja a termékeket és a mennyiségeket, valamint a szállítási napot, majd a „Rendelés leadása” gombbal elküldi a rendelést. A rendelés elküldéséig az adatok szabadon módosíthatók.',
        `Rendelési határidő: a szállítási napot legalább ${lead} nappal megelőzően, ${cut} óráig (budapesti idő szerint) leadott rendelés teljesíthető; a határidő után leadott rendelés legkorábbi szállítási napja egy nappal később van. A választható szállítási napokat a felület mutatja.`,
        'A rendelés beérkezéséről a Gyártó haladéktalanul, legkésőbb 48 órán belül elektronikus visszaigazolást küld. A szerződés a Gyártó elfogadó visszaigazolásával („Visszaigazolva”) jön létre; a szerződést a Gyártó elektronikusan tárolja, az a felületen az Ügyfél számára hozzáférhető. A szerződés nyelve magyar.',
        'Amíg a rendelés „Visszaigazolásra vár” állapotban van, az Ügyfél a felületen díjmentesen lemondhatja. A visszaigazolt rendelés módosítása vagy lemondása csak a Gyártóval egyeztetve lehetséges.',
      ] },
      { h: '7. Szállítás és átvétel', p: [
        'A Gyártó a terméket a visszaigazolt szállítási napon az Ügyfél által megadott címre szállítja. Az átvételt az Ügyfél képviselője a szállítólevélen aláírásával igazolja; a Gyártó az átvételről fényképet készíthet.',
        'A kárveszély az átvétellel száll át az Ügyfélre. Az átvételt követően a termék előírt hőmérsékleten való tárolása és a fogyaszthatósági időn belüli felhasználása az Ügyfél felelőssége.',
      ] },
      { h: '8. Fizetés', p: [
        'A vételárat az Ügyfél a Gyártó által kiállított számla alapján, banki átutalással, a számlán feltüntetett fizetési határidőn belül fizeti meg. Késedelmes fizetés esetén a Ptk. vállalkozások közötti szerződésekre vonatkozó késedelmi kamatra és behajtási költségátalányra vonatkozó szabályai alkalmazandók.',
      ] },
      { h: '9. Minőségi kifogás', p: [
        'Az Ügyfél köteles a terméket átvételkor megvizsgálni. Mennyiségi eltérést, sérült csomagolást vagy szemmel látható hibát az átvételkor, a szállítólevélen kell jelezni.',
        `Egyéb minőségi kifogást az Ügyfél legkésőbb az átvétel napján köteles jelezni a ${v(i.company_email)} címen, a rendelésszám, a tétel (gyártási) azonosító és fényképek megadásával; a kifogásolt terméket a kivizsgálásig az előírt módon meg kell őrizni.`,
        'Megalapozott kifogás esetén a Gyártó választása szerint a terméket pótolja, vagy az árát jóváírja.',
      ] },
      { h: '10. Felelősség', p: [
        'A Gyártó felelőssége – a szándékosan vagy súlyos gondatlansággal okozott, továbbá az emberi életet, testi épséget vagy egészséget megkárosító szerződésszegés kivételével – a kifogásolt termék nettó árának összegéig terjed. A Gyártó nem felel az Ügyfél nem megfelelő tárolásából vagy felhasználásából eredő károkért.',
      ] },
      { h: '11. Adatkezelés', p: ['A személyes adatok kezelésére az Adatkezelési tájékoztató irányadó.'] },
      { h: '12. Egyéb rendelkezések', p: [
        'A Gyártó jogosult jelen feltételeket módosítani; a módosítás a felületen való közzététel után leadott rendelésekre vonatkozik.',
        'A felek a vitáikat elsősorban tárgyalás útján rendezik; ennek sikertelensége esetén a hatáskörrel rendelkező, a Gyártó székhelye szerint illetékes bíróság jár el.',
      ] },
    ],
  }
  return {
    title: 'General Terms and Conditions (for businesses)',
    intro: `Effective: ${v(i.terms_version)}. These terms apply to contracts between ${v(i.company_name)} (the Producer) and businesses ordering on ${SITE} (the Customer). This is a courtesy translation; the Hungarian version prevails.`,
    sections: [
      { h: '1. Producer', p: [company(i, 'en')] },
      { h: '2. Scope: businesses only', p: [
        'The ordering site is available to businesses only (e.g. restaurants, caterers, retailers). The Producer does not sell to consumers on this site, so consumer-contract rules (e.g. the 14-day right of withdrawal) do not apply.',
        'Contracts are governed by Hungarian law, in particular the Civil Code (Act V of 2013). The Customer\'s own terms apply only if the Producer expressly accepts them in writing.',
      ] },
      { h: '3. Access', p: [
        'Only users approved by the Producer can sign in. Users must keep their login details secret; orders placed with an account are deemed to be orders of the Customer.',
        'The Customer accepts these terms when requesting access or before the first order. When the terms change, the new version must be accepted before the next order.',
      ] },
      { h: '4. Products and product information', p: [
        'The Producer sells freshly made noodle products. Ingredients, allergens (in bold), net quantity, storage conditions and use-by / best-before period are shown under "Product information" on the ordering site, on the product label and on the delivery note.',
        'Product photos are illustrations.',
      ] },
      { h: '5. Prices', p: [
        'Prices on the site and in confirmations are net prices in HUF, plus VAT at the applicable rate.',
        'Individual prices may be agreed with a Customer. The price shown when the order is placed applies; later price changes do not affect orders already placed.',
      ] },
      { h: '6. Ordering and conclusion of the contract', p: [
        'The Customer selects products, quantities and a delivery date and sends the order with "Place order". Until then everything can be changed freely.',
        `Order cutoff: orders placed at least ${lead} day(s) before the delivery date, by ${cut} (Budapest time), can be fulfilled; after the cutoff the earliest delivery date moves one day later. The site shows the dates that can be chosen.`,
        'The Producer acknowledges receipt of the order electronically without delay, within 48 hours at the latest. The contract is concluded when the Producer confirms the order ("Confirmed"); it is stored electronically and available to the Customer on the site. The contract language is Hungarian.',
        'While an order is "Waiting for confirmation" the Customer can cancel it on the site free of charge. Confirmed orders can only be changed or cancelled in agreement with the Producer.',
      ] },
      { h: '7. Delivery and acceptance', p: [
        'The Producer delivers on the confirmed delivery date to the address given by the Customer. The Customer\'s representative confirms receipt by signing the delivery note; the Producer may take a photo of the handover.',
        'Risk passes to the Customer on delivery. After delivery the Customer is responsible for storing the product at the required temperature and using it within its use-by period.',
      ] },
      { h: '8. Payment', p: [
        'The Customer pays by bank transfer on the basis of the Producer\'s invoice, within the payment term stated on the invoice. For late payment the Civil Code rules on late-payment interest and the recovery-cost lump sum between businesses apply.',
      ] },
      { h: '9. Quality complaints', p: [
        'The Customer must inspect the products on delivery. Missing quantities, damaged packaging or visible defects must be noted on the delivery note at delivery.',
        `Other quality complaints must be reported on the day of delivery at the latest to ${v(i.company_email)}, with the order number, the batch (lot) ID and photos; the product concerned must be kept as required until the complaint is examined.`,
        'If the complaint is justified, the Producer will, at its choice, replace the product or credit its price.',
      ] },
      { h: '10. Liability', p: [
        'Except for breaches caused intentionally or by gross negligence, or causing harm to life, physical integrity or health, the Producer\'s liability is limited to the net price of the product concerned. The Producer is not liable for damage resulting from improper storage or use by the Customer.',
      ] },
      { h: '11. Personal data', p: ['Personal data are handled as described in the Privacy notice.'] },
      { h: '12. Other provisions', p: [
        'The Producer may change these terms; changes apply to orders placed after publication on the site.',
        'The parties will try to settle disputes by negotiation; failing that, the competent court at the Producer\'s registered office has jurisdiction.',
      ] },
    ],
  }
}

export function privacy(i, lang) {
  const proc = lang === 'hu' ? [
    'Supabase, Inc. (supabase.com) – adatbázis, bejelentkezés, fájltárolás; az adatok az Európai Unióban (Írország) tárolódnak.',
    'Vercel Inc. (vercel.com, USA) – a weboldal kiszolgálása (tárhely).',
    'Resend (resend.com, USA) – a rendelési e-mailek kézbesítése.',
  ] : [
    'Supabase, Inc. (supabase.com) – database, sign-in, file storage; data are stored in the European Union (Ireland).',
    'Vercel Inc. (vercel.com, USA) – serving the website (hosting).',
    'Resend (resend.com, USA) – delivering order e-mails.',
  ]
  if (lang === 'hu') return {
    title: 'Adatkezelési tájékoztató',
    intro: `Hatályos: ${v(i.terms_version)}. A ${SITE} rendelési felülettel kapcsolatos adatkezelésről (az Európai Parlament és a Tanács (EU) 2016/679 rendelete – GDPR – 13. cikke alapján).`,
    sections: [
      { h: '1. Az adatkezelő', p: [company(i, 'hu'), `Adatvédelmi kérdésekben: ${v(i.company_email)}`] },
      { h: '2. Kezelt adatok, célok és jogalapok', p: [[
        'Felhasználói fiók (e-mail cím, jelszó titkosított formában, név, cégnév, telefonszám, nyelvi beállítás): a felülethez való hozzáférés és a kapcsolattartás – szerződés teljesítése, illetve az Ügyfél (vállalkozás) jogos érdeke a kapcsolattartó személy útján történő kapcsolattartásra (GDPR 6. cikk (1) b) és f) pont).',
        'Rendelési és szállítási adatok (rendelések, szállítási cím, átvevő neve, szállítólevél): a szerződés teljesítése (6. cikk (1) b) pont); a számviteli bizonylatok megőrzése jogi kötelezettség (6. cikk (1) c) pont, a számvitelről szóló 2000. évi C. törvény 169. §).',
        'Átvételi fénykép (aláírt szállítólevél vagy átadott áru): az átvétel igazolása, esetleges reklamáció rendezése – a Gyártó jogos érdeke (6. cikk (1) f) pont).',
        'Rendelési e-mailek (visszaigazolás): a szerződés teljesítése (6. cikk (1) b) pont).',
      ]] },
      { h: '3. Megőrzési idő', p: [[
        'Felhasználói fiók: a fiók törléséig, illetve az üzleti kapcsolat megszűnéséig.',
        'Rendelési és szállítási bizonylatok: a számviteli szabályok szerint 8 évig.',
        'Átvételi fényképek: a szállítást követő 2 évig.',
      ]] },
      { h: '4. Adatfeldolgozók és adattovábbítás', p: [proc,
        'Az Európai Unión kívüli (USA) szolgáltatók részére történő adattovábbítás az EU–USA adatvédelmi keret vagy az Európai Bizottság által elfogadott általános adatvédelmi kikötések alapján történik. Az adatokat harmadik félnek egyéb célra nem adjuk át.'] },
      { h: '5. Sütik és helyi tárolás', p: ['A felület csak a működéshez szükséges helyi tárolást használ (bejelentkezés megőrzése, nyelvi beállítás). Analitikai vagy marketing célú sütit nem használunk, ezért ezekhez hozzájárulás nem szükséges.'] },
      { h: '6. Az érintettek jogai', p: [
        'Ön kérheti a személyes adataihoz való hozzáférést, azok helyesbítését, törlését vagy kezelésének korlátozását, tiltakozhat a jogos érdeken alapuló adatkezelés ellen, és kérheti az adatai hordozható formában történő átadását. Kérelmét a fenti e-mail címre küldheti; arra legfeljebb egy hónapon belül válaszolunk.',
        'Panaszt a Nemzeti Adatvédelmi és Információszabadság Hatóságnál (NAIH, 1055 Budapest, Falk Miksa utca 9–11., www.naih.hu) tehet, illetve bírósághoz fordulhat.',
      ] },
    ],
  }
  return {
    title: 'Privacy notice',
    intro: `Effective: ${v(i.terms_version)}. How personal data are handled on ${SITE} (GDPR, Article 13). Courtesy translation; the Hungarian version prevails.`,
    sections: [
      { h: '1. Controller', p: [company(i, 'en'), `Data protection questions: ${v(i.company_email)}`] },
      { h: '2. Data, purposes and legal bases', p: [[
        'User account (e-mail, password in encrypted form, name, company, phone, language): access to the site and keeping in touch – performance of the contract and the legitimate interest of keeping in touch with the customer\'s contact person (GDPR Art. 6(1)(b) and (f)).',
        'Order and delivery data (orders, delivery address, name of the receiver, delivery note): performance of the contract (Art. 6(1)(b)); keeping accounting records is a legal obligation (Art. 6(1)(c), Hungarian Accounting Act, Section 169).',
        'Delivery photo (signed delivery note or handed-over goods): proof of delivery and handling complaints – the Producer\'s legitimate interest (Art. 6(1)(f)).',
        'Order e-mails (confirmations): performance of the contract (Art. 6(1)(b)).',
      ]] },
      { h: '3. Retention', p: [[
        'User account: until the account is deleted or the business relationship ends.',
        'Order and delivery records: 8 years under accounting rules.',
        'Delivery photos: 2 years after delivery.',
      ]] },
      { h: '4. Processors and transfers', p: [proc,
        'Transfers to providers outside the EU (USA) are based on the EU–US Data Privacy Framework or the European Commission\'s standard contractual clauses. Data are not passed to third parties for any other purpose.'] },
      { h: '5. Cookies and local storage', p: ['The site only uses local storage needed for it to work (staying signed in, language). No analytics or marketing cookies are used, so no consent is required for them.'] },
      { h: '6. Your rights', p: [
        'You can request access to, correction, erasure or restriction of your personal data, object to processing based on legitimate interest, and request your data in a portable format. Send your request to the e-mail address above; we reply within one month.',
        'You can complain to the Hungarian data protection authority (NAIH, 1055 Budapest, Falk Miksa utca 9–11., www.naih.hu) or go to court.',
      ] },
    ],
  }
}

export const DOCS = { impresszum, aszf, adatvedelem: privacy }
