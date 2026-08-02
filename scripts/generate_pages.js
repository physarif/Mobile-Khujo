const { initializeApp, cert, getApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const fs = require('fs');

// Firebase env var validation 
const REQUIRED_ENV = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    console.error('GitHub Secrets সঠিকভাবে set করা আছে কিনা চেক করুন।');
    process.exit(1);
  }
}

// Firebase init (firebase-admin v12+ modular import)
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID.trim(),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL.trim(),
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').trim(),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL.trim(),
});

const db = getDatabase();

// TODO: নিজের ডোমেইন বসান
const SITE_URL = 'https://mobilekhujo.pages.dev';
const DEFAULT_OG_IMAGE = `${SITE_URL}/assets/photos/og-banner.webp`;

const PHONES_PER_PAGE = 12;

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

// HTML escape (XSS-safe ground truth)
function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return (str || '')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toBanglaNum(n) {
  return String(n).replace(/[0-9]/g, d => '০১২৩৪৫৬৭৮৯'[d]);
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// দাম কে "৳ ১৫,৯৯০" স্টাইলে ফরম্যাট করে (বাংলাদেশি লাখ/হাজার গ্রুপিং সহ)
function formatMoney(n) {
  const num = Number(n);
  if (!num || isNaN(num) || num <= 0) return '';
  const grouped = num.toLocaleString('en-IN');
  return '৳' + toBanglaNum(grouped);
}

const BN_MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];

function formatDateBn(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return escapeHtml(String(dateStr));
  return `${toBanglaNum(d.getDate())} ${BN_MONTHS[d.getMonth()]}, ${toBanglaNum(d.getFullYear())}`;
}

const STATUS_LABELS = {
  available: 'Available',
  unavailable: 'Out of Stock',
  upcoming: 'Coming Soon',
};

// দাম কে "৳50,000" স্টাইলে ফরম্যাট করে (ইংরেজি সংখ্যা, western grouping) — ফোন ডিটেইল পেজের জন্য
function formatMoneyEn(n) {
  const num = Number(n);
  if (!num || isNaN(num) || num <= 0) return '';
  return '৳' + num.toLocaleString('en-US');
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatDateEn(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return escapeHtml(String(dateStr));
  return `${d.getDate()} ${EN_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.available;
}

function statusClass(status) {
  return ['available', 'unavailable', 'upcoming'].includes(status) ? status : 'available';
}

// brand key (Firebase key) থেকে আসল নাম/স্লাগ বের করা — brands/{key} রেফারেন্স
function resolveBrand(brandKey, brandsMap) {
  if (!brandKey) return { name: '', slug: '' };
  const b = brandsMap[brandKey];
  if (b) {
    const name = b.title || brandKey;
    return { name, slug: b.slug || slugify(name) };
  }
  // পুরনো ডেটায় brand ফিল্ডে সরাসরি নাম থাকতে পারে — সেক্ষেত্রে fallback
  return { name: brandKey, slug: slugify(brandKey) };
}

// Template load
const layout = fs.readFileSync('components/layout.html', 'utf8');
const indexTemplate = fs.readFileSync('components/index.html', 'utf8');
const phoneTemplate = fs.readFileSync('components/phone.html', 'utf8');

// hero_tag/page_type/robots_meta — না দিলেও ভুল markup তৈরি না হয় তার জন্য default
const DEFAULT_RENDER_DATA = {
  hero_tag: 'div',
  page_type: 'website',
  robots_meta: 'index, follow',
  brand_links: '',
  archive_links: '',
};

function render(template, data) {
  const merged = Object.assign({}, DEFAULT_RENDER_DATA, data);
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = merged[key] != null ? String(merged[key]) : '';
    return val.replace(/\$/g, '$$$$');
  });
}

// Phone card template (হোমপেজ লিস্ট)
const cardTemplate = [
  '<a href="/phone/{{phone_slug}}.html" class="mk-card">',
  '  <div class="mk-img-wrap">',
  '    <img src="{{phone_image}}" alt="{{phone_name}}" class="mk-img" loading="lazy">',
  '  </div>',
  '  <div class="mk-body">',
  '    <p class="mk-headline"><span class="mk-title">{{phone_name}}</span></p>',
  '    <p class="mk-meta">{{phone_brand}} · <span class="mk-price">{{phone_price}}</span></p>',
  '    <p class="mk-desc">{{phone_summary}}</p>',
  '  </div>',
  '</a>',
].join('\n');

function phoneCard(phone) {
  return render(cardTemplate, {
    phone_slug: phone.slug,
    phone_image: phone.image,
    phone_name: escapeHtml(phone.name),
    phone_brand: escapeHtml(phone.brandName),
    phone_price: escapeHtml(formatMoney(phone.price) || '—'),
    phone_summary: escapeHtml(phone.summary).slice(0, 200),
  });
}

const chipTemplate = '<a href="{{href}}" class="mk-chip">{{label}}</a>';
const sidebarLinkTemplate = '<li><a href="{{href}}" class="hover:text-brand-500">{{label}}</a></li>';

// ─────────────────────────────────────────────────────────
// ফোন ডিটেইল পেজের জন্য spec/rating/pros-cons/variants বিল্ডার
// ─────────────────────────────────────────────────────────

const YES_NO = v => (v ? 'Yes' : 'No');

const SPEC_GROUPS = [
  {
    title: 'Body',
    key: 'body',
    fields: [
      ['dimensions', 'Dimensions', v => v],
      ['weight_g', 'Weight', v => `${v} g`],
      ['build', 'Build', v => v],
      ['sim', 'SIM', v => v],
      ['protection', 'Protection', v => v],
    ],
  },
  {
    title: 'Display',
    key: 'display',
    fields: [
      ['type', 'Display Type', v => v],
      ['size_inch', 'Screen Size', v => `${v} inches`],
      ['resolution', 'Resolution', v => v],
      ['pixel_density', 'Pixel Density', v => `${v} ppi`],
      ['screen_to_body', 'Screen to Body Ratio', v => `${v}%`],
      ['screen_protection', 'Screen Protection', v => v],
      ['touch_screen', 'Touch Screen', v => v],
      ['refresh_hz', 'Refresh Rate', v => `${v} Hz`],
      ['brightness_nits', 'Brightness', v => `${v} nits`],
      ['notch', 'Notch', v => v],
      ['display_features', 'Features', v => v],
    ],
  },
  {
    title: 'Platform',
    key: 'platform',
    fields: [
      ['os', 'Operating System', v => v],
      ['os_version', 'OS Version', v => v],
      ['ui', 'User Interface', v => v],
      ['chipset', 'Chipset', v => v],
      ['cpu', 'CPU', v => v],
      ['cpu_cores', 'CPU Cores', v => v],
      ['architecture', 'Architecture', v => v],
      ['fabrication', 'Fabrication', v => v],
      ['gpu', 'GPU', v => v],
    ],
  },
  {
    title: 'Memory',
    key: 'memory',
    fields: [
      ['ram_gb', 'RAM', v => `${v} GB`],
      ['storage_gb', 'Storage', v => `${v} GB`],
      ['card_slot', 'Card Slot', YES_NO],
    ],
  },
  {
    title: 'Main Camera',
    key: 'main_camera',
    fields: [
      ['main_camera_mp', 'Resolution', v => v],
      ['main_camera_setup', 'Setup', v => v],
      ['main_camera_features', 'Features', v => v],
      ['main_camera_video', 'Video', v => v],
    ],
  },
  {
    title: 'Selfie Camera',
    key: 'selfie_camera',
    fields: [
      ['selfie_camera_mp', 'Resolution', v => v],
      ['selfie_camera_setup', 'Setup', v => v],
      ['selfie_camera_video', 'Video', v => v],
    ],
  },
  {
    title: 'Sound',
    key: 'sound',
    fields: [
      ['loudspeaker', 'Loudspeaker', YES_NO],
      ['jack_3_5mm', '3.5mm Jack', YES_NO],
    ],
  },
  {
    title: 'Connectivity',
    key: 'connectivity',
    fields: [
      ['network', 'Network', v => v],
      ['wlan', 'WLAN', v => v],
      ['bluetooth', 'Bluetooth', v => v],
      ['gps', 'GPS', v => v],
      ['nfc', 'NFC', YES_NO],
      ['fm_radio', 'FM Radio', YES_NO],
      ['usb', 'USB', v => v],
    ],
  },
  {
    title: 'Features',
    key: 'features',
    fields: [
      ['sensors', 'Sensors', v => v],
    ],
  },
  {
    title: 'Battery',
    key: 'battery',
    fields: [
      ['capacity_mah', 'Capacity', v => `${v} mAh`],
      ['charging_watt', 'Charging', v => `${v}W wired`],
      ['wireless', 'Wireless Charging', YES_NO],
      ['reverse', 'Reverse Charging', YES_NO],
    ],
  },
];

function buildSpecSections(specs) {
  if (!specs) return '';
  let html = '';
  for (const group of SPEC_GROUPS) {
    const groupData = specs[group.key];
    if (!groupData) continue;
    const rows = group.fields
      .map(([field, label, fmt]) => {
        const raw = groupData[field];
        if (raw === undefined || raw === null || raw === '') return '';
        const value = fmt(raw);
        if (value === '' || value === null || value === undefined) return '';
        return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(String(value))}</td></tr>`;
      })
      .filter(Boolean)
      .join('');
    if (!rows) continue;
    html += `<div class="mk-pd-spec-group-title">${escapeHtml(group.title)}</div>`;
    html += `<table class="mk-pd-spectable"><tbody>${rows}</tbody></table>`;
  }
  return html;
}

// হোমপেজ কার্ড ও ডিটেইল হেডারে দেখানোর জন্য কিছু কী স্পেসিফিকেশন বেছে নেওয়া (আইকন গ্রিড — MobileDokan স্টাইল)
function buildQuickSpecs(specs) {
  if (!specs) return '';
  const items = [
    ['fa-solid fa-hard-drive', 'Storage', specs.memory && specs.memory.storage_gb ? `${specs.memory.storage_gb}GB` : ''],
    ['fa-solid fa-microchip', 'RAM', specs.memory && specs.memory.ram_gb ? `${specs.memory.ram_gb}GB` : ''],
    ['fa-solid fa-camera', 'Main Camera', specs.main_camera && specs.main_camera.main_camera_mp],
    ['fa-solid fa-camera-retro', 'Front Camera', specs.selfie_camera && specs.selfie_camera.selfie_camera_mp],
    ['fa-solid fa-mobile-screen-button', 'Display', specs.display && specs.display.size_inch ? `${specs.display.size_inch}" ${specs.display.resolution || ''}`.trim() : ''],
    ['fa-solid fa-battery-full', 'Battery', specs.battery && specs.battery.capacity_mah ? `${specs.battery.capacity_mah}mAh` : ''],
  ].filter(([, , v]) => v);

  if (!items.length) return '';

  const osLabel = specs.platform && specs.platform.os ? specs.platform.os : '';
  const osRow = osLabel
    ? `<div class="mk-pd-osrow"><i class="fa-brands fa-android"></i> ${escapeHtml(osLabel)}</div>`
    : '';

  const grid = items
    .map(([icon, label, value]) => (
      `<div class="mk-pd-quickitem">`
      + `<div class="mk-pd-quickicon"><i class="${icon}"></i></div>`
      + `<div class="mk-pd-quicktext">`
      + `<div class="mk-pd-quicklabel">${escapeHtml(label)}</div>`
      + `<div class="mk-pd-quickvalue">${escapeHtml(String(value))}</div>`
      + `</div></div>`
    ))
    .join('');

  // ছোট ফিচার আইকন স্ট্রিপ — শুধু যেসব ফিচার ডেটায় আছে সেগুলোই দেখাবে
  const featureChecks = [
    ['fa-solid fa-fingerprint', specs.features && /finger/i.test(specs.features.sensors || '')],
    ['fa-solid fa-bolt', specs.battery && Number(specs.battery.charging_watt) > 0],
    ['fa-solid fa-droplet', specs.body && !!specs.body.protection],
    ['fa-solid fa-wifi', specs.connectivity && !!specs.connectivity.wlan],
    ['fa-solid fa-signal', specs.connectivity && !!specs.connectivity.network],
    ['fa-brands fa-bluetooth-b', specs.connectivity && !!specs.connectivity.bluetooth],
  ].filter(([, ok]) => ok);
  const featureStrip = featureChecks.length
    ? `<div class="mk-pd-feature-strip">${featureChecks.map(([icon]) => `<i class="${icon}"></i>`).join('')}</div>`
    : '';

  return (
    `<section class="mk-pd-section" id="key-specs">`
    + `<div class="mk-pd-title-row"><div class="mk-pd-title">Key Specifications</div><a href="#full-specs" class="mk-pd-seefull">See Full Specs <i class="fas fa-chevron-right"></i></a></div>`
    + osRow
    + `<div class="mk-pd-quickgrid">${grid}</div>`
    + featureStrip
    + `</section>`
  );
}

const RATING_LABELS = {
  display: 'Display',
  performance: 'Performance',
  camera: 'Camera',
  battery: 'Battery',
  design_build: 'Design',
  software: 'Software',
};

function buildRatingBlock(rating) {
  if (!rating) return '';
  const rows = Object.keys(RATING_LABELS)
    .map(key => {
      const val = Number(rating[key]);
      if (!val || isNaN(val)) return '';
      const pct = Math.max(0, Math.min(100, (val / 10) * 100));
      return (
        `<div class="mk-pd-rating-row">`
        + `<span class="mk-pd-rating-label">${escapeHtml(RATING_LABELS[key])}</span>`
        + `<span class="mk-pd-rating-track"><span class="mk-pd-rating-fill" style="width:${pct}%"></span></span>`
        + `<span class="mk-pd-rating-num">${val}</span>`
        + `</div>`
      );
    })
    .filter(Boolean)
    .join('');
  if (!rows) return '';
  return `<section class="mk-pd-section"><div class="mk-pd-title">Our Rating</div>${rows}</section>`;
}

function buildProsConsBlock(pros, cons) {
  const prosList = Array.isArray(pros) ? pros.filter(Boolean) : [];
  const consList = Array.isArray(cons) ? cons.filter(Boolean) : [];
  if (!prosList.length && !consList.length) return '';

  const prosHtml = prosList.map(p => `<li><i class="fas fa-check-circle"></i> ${escapeHtml(p)}</li>`).join('');
  const consHtml = consList.map(c => `<li><i class="fas fa-times-circle"></i> ${escapeHtml(c)}</li>`).join('');

  return (
    `<section class="mk-pd-section"><div class="mk-pd-title">Pros & Cons</div>`
    + `<div class="mk-pd-proscons">`
    + `<div class="mk-pd-pros"><h4>Pros</h4><ul>${prosHtml || '<li>—</li>'}</ul></div>`
    + `<div class="mk-pd-cons"><h4>Cons</h4><ul>${consHtml || '<li>—</li>'}</ul></div>`
    + `</div></section>`
  );
}

function buildVariantsBlock(variants) {
  const list = Array.isArray(variants) ? variants.filter(v => v && (v.variant || v.price)) : [];
  if (!list.length) return '';
  const pills = list
    .map(v => (
      `<div class="mk-pd-variant-pill">`
      + `<span class="mk-pd-variant-name">${escapeHtml(v.variant || '—')}</span>`
      + `<span class="mk-pd-variant-price">${escapeHtml(formatMoneyEn(v.price) || '—')}</span>`
      + `</div>`
    ))
    .join('');
  return (
    `<section class="mk-pd-section"><div class="mk-pd-title">Variants</div>`
    + `<div class="mk-pd-variantwrap">${pills}</div></section>`
  );
}

function buildGalleryThumbs(gallery, mainImage) {
  const imgs = (Array.isArray(gallery) ? gallery : []).filter(Boolean);
  // মেইন ইমেজ বাদ দিয়ে বাকি ছবিগুলো থাম্বনেইল হিসেবে দেখানো
  const rest = imgs.filter(src => src !== mainImage);
  if (!rest.length) return '';
  const thumbs = rest
    .map(src => `<img src="${escapeAttr(src)}" alt="" loading="lazy">`)
    .join('');
  return `<div class="mk-pd-gallery">${thumbs}</div>`;
}

// ─────────────────────────────────────────────────────────
// Firebase থেকে phones + brands ডেটা নিয়ে normalize করা
// ─────────────────────────────────────────────────────────

function buildPhoneList(phonesRaw, brandsMap) {
  return Object.entries(phonesRaw).map(([firebaseKey, phone]) => {
    const brand = resolveBrand(phone.brand, brandsMap);
    const variants = Array.isArray(phone.variants) ? phone.variants : [];
    const variantPrices = variants.map(v => Number(v.price)).filter(n => !isNaN(n) && n > 0);
    const variantMin = variantPrices.length ? Math.min(...variantPrices) : null;
    const price = variantMin != null ? variantMin : (Number(phone.price) || 0);

    return {
      key: firebaseKey,
      id: phone.id != null ? phone.id : (parseInt(firebaseKey, 10) || firebaseKey),
      slug: phone.slug || slugify(phone.name),
      name: phone.name || '',
      image: phone.img || (Array.isArray(phone.gallery) ? phone.gallery[0] : '') || '',
      gallery: Array.isArray(phone.gallery) ? phone.gallery : [],
      price,
      status: phone.status || 'available',
      released: phone.released || '',
      brandKey: phone.brand || '',
      brandName: brand.name,
      brandSlug: brand.slug,
      summary: phone.summary || phone.desc || '',
      variants,
      specs: phone.specs || {},
      rating: phone.rating || null,
      extra_pros: Array.isArray(phone.extra_pros) ? phone.extra_pros : [],
      extra_cons: Array.isArray(phone.extra_cons) ? phone.extra_cons : [],
      created_at: phone.createdAt || 0,
    };
  });
}

// ─────────────────────────────────────────────────────────
// হোমপেজ (+ পেজিনেশন) জেনারেট
// ─────────────────────────────────────────────────────────

async function generateHomepage(phoneList, brandLinksHtml) {
  console.log(`✅ ${phoneList.length}টা ফোন পাওয়া গেছে।`);

  // created_at দিয়ে sort (নতুন আগে)
  const sorted = [...phoneList].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const totalPages = Math.ceil(sorted.length / PHONES_PER_PAGE) || 1;

  // ব্র্যান্ড chips — unique, নাম অনুযায়ী sort
  const brandNames = [...new Map(
    phoneList.filter(p => p.brandName).map(p => [p.brandSlug, p.brandName])
  ).entries()].sort((a, b) => a[1].localeCompare(b[1], 'bn'));
  const brandChips = brandNames
    .map(([slug, name]) => render(chipTemplate, { href: `/brands/${slug}.html`, label: escapeHtml(name) }))
    .join('');

  // বাজেট chips — ডিফল্ট রেঞ্জ (Firebase-এ আলাদা budget ডেটা নেই এই স্কিমায়)
  const DEFAULT_BUDGET_RANGES = ['১০ হাজারের নিচে', '১০-২০ হাজার', '২০-৩০ হাজার', 'ফ্ল্যাগশিপ'];
  const budgetChips = DEFAULT_BUDGET_RANGES
    .map(label => render(chipTemplate, { href: `/budget/${slugify(label)}.html`, label: escapeHtml(label) }))
    .join('');

  for (let page = 1; page <= totalPages; page++) {
    const pagePhones = sorted.slice((page - 1) * PHONES_PER_PAGE, page * PHONES_PER_PAGE);

    const pageContent = render(indexTemplate, {
      brand_chips: brandChips,
      budget_chips: budgetChips,
      latest_phones: pagePhones.map(phoneCard).join(''),
      current_page: page,
      total_pages: totalPages,
      current_page_bn: toBanglaNum(page),
      total_pages_bn: toBanglaNum(totalPages),
      total_phones_bn: toBanglaNum(sorted.length),
    });

    const fullPage = render(layout, {
      page_title: page === 1
        ? 'Mobile Khujo – ফোন রিভিউ ও তুলনা'
        : `পাতা ${page}`,
      full_title: page === 1
        ? escapeAttr('Mobile Khujo – ফোন রিভিউ ও তুলনা')
        : escapeAttr(`পাতা ${page} - Mobile Khujo`),
      page_description: 'ব্র্যান্ড ও বাজেট অনুযায়ী মোবাইল ফোনের রিভিউ, স্পেসিফিকেশন ও দাম তুলনা করুন।',
      page_image: DEFAULT_OG_IMAGE,
      page_url: page === 1 ? SITE_URL : `${SITE_URL}/phones/${page}/`,
      // শুধু আসল হোমপেজে (page 1) ব্র্যান্ড-নাম H1 হবে
      hero_tag: page === 1 ? 'h1' : 'div',
      brand_links: brandLinksHtml,
      content: pageContent,
    });

    if (page === 1) {
      fs.writeFileSync('index.html', fullPage, 'utf8');
      console.log('  ✓ index.html');
    } else {
      const dir = `phones/${page}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/index.html`, fullPage, 'utf8');
      console.log(`  ✓ phones/${page}/index.html`);
    }
  }
}

// ─────────────────────────────────────────────────────────
// প্রতিটা ফোনের জন্য আলাদা ডিটেইল পেজ জেনারেট
// ─────────────────────────────────────────────────────────

async function generatePhonePages(phoneList, brandLinksHtml) {
  fs.mkdirSync('phone', { recursive: true });

  for (const phone of phoneList) {
    if (!phone.slug) {
      console.log(`  ⚠️  স্কিপ করা হলো (slug নেই): ${phone.name || phone.key}`);
      continue;
    }

    const priceDisplay = phone.variants.length > 1
      ? `Starting from ${formatMoneyEn(phone.price)}`
      : (formatMoneyEn(phone.price) || 'Price unavailable');

    const pageContent = render(phoneTemplate, {
      phone_name: escapeHtml(phone.name),
      phone_brand_name: escapeHtml(phone.brandName || 'Unknown'),
      phone_brand_slug: phone.brandSlug || '',
      phone_status_class: statusClass(phone.status),
      phone_status_label: statusLabel(phone.status),
      phone_price_display: escapeHtml(priceDisplay),
      phone_released_bn: formatDateEn(phone.released) || 'TBA',
      phone_image: escapeAttr(phone.image),
      phone_summary: escapeHtml(phone.summary),
      gallery_thumbs_block: buildGalleryThumbs(phone.gallery, phone.image),
      quick_specs_block: buildQuickSpecs(phone.specs),
      rating_block: buildRatingBlock(phone.rating),
      proscons_block: buildProsConsBlock(phone.extra_pros, phone.extra_cons),
      variants_block: buildVariantsBlock(phone.variants),
      spec_sections: buildSpecSections(phone.specs) || '<p style="color:#9ca3af;font-size:0.9rem;">Specifications not added yet.</p>',
    });

    const summaryForMeta = (phone.summary || `${phone.name} - Price, Specifications & Review`).slice(0, 155);

    const fullPage = render(layout, {
      page_title: phone.name,
      full_title: escapeAttr(`${phone.name} Price & Full Specifications - Mobile Khujo`),
      page_description: escapeAttr(summaryForMeta),
      page_image: phone.image || DEFAULT_OG_IMAGE,
      page_url: `${SITE_URL}/phone/${phone.slug}.html`,
      page_type: 'product',
      hero_tag: 'div',
      brand_links: brandLinksHtml,
      content: pageContent,
    });

    fs.writeFileSync(`phone/${phone.slug}.html`, fullPage, 'utf8');
    console.log(`  ✓ phone/${phone.slug}.html`);
  }
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

(async () => {
  try {
    console.log('🚀 Script শুরু হয়েছে...');
    console.log('📱 Firebase থেকে phone ও brand data fetch করছি...');

    const [phonesSnap, brandsSnap] = await Promise.all([
      db.ref('/phones').orderByKey().once('value'),
      db.ref('/brands').orderByKey().once('value'),
    ]);

    const phonesRaw = phonesSnap.val() || {};
    const brandsMap = brandsSnap.val() || {};

    if (Object.keys(phonesRaw).length === 0) {
      console.log('⚠️  কোনো phone data পাওয়া যায়নি — খালি হোমপেজ generate করছি।');
    }

    const phoneList = buildPhoneList(phonesRaw, brandsMap);

    // সাইডবারের "Brands" অ্যাকর্ডিয়নের জন্য লিংক তৈরি
    const brandLinksHtml = Object.values(brandsMap)
      .filter(b => b && b.title)
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'bn'))
      .map(b => render(sidebarLinkTemplate, { href: `/brands/${b.slug || slugify(b.title)}.html`, label: escapeHtml(b.title) }))
      .join('');

    await generateHomepage(phoneList, brandLinksHtml);
    console.log('🎉 হোমপেজ generate হয়েছে!');

    console.log('📄 ফোন ডিটেইল পেজ generate করছি...');
    await generatePhonePages(phoneList, brandLinksHtml);
    console.log('🎉 ফোন ডিটেইল পেজগুলো generate হয়েছে!');

    await getApp().delete();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    await getApp().delete().catch(() => {});
    process.exit(1);
  }
})();
