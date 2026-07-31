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

// Template load
const layout = fs.readFileSync('components/layout.html', 'utf8');
const indexTemplate = fs.readFileSync('components/index.html', 'utf8');

// hero_tag/page_type/robots_meta — না দিলেও ভুল markup তৈরি না হয় তার জন্য default
const DEFAULT_RENDER_DATA = {
  hero_tag: 'div',
  page_type: 'website',
  robots_meta: 'index, follow',
};

function render(template, data) {
  const merged = Object.assign({}, DEFAULT_RENDER_DATA, data);
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = merged[key] != null ? String(merged[key]) : '';
    return val.replace(/\$/g, '$$$$');
  });
}

// Phone card template
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
    phone_brand: escapeHtml(phone.brand),
    phone_price: escapeHtml(phone.price),
    phone_summary: escapeHtml(phone.summary).slice(0, 200),
  });
}

const chipTemplate = '<a href="{{href}}" class="mk-chip">{{label}}</a>';

async function generateHomepage() {
  console.log('📱 Firebase থেকে phone data fetch করছি...');

  const phonesSnap = await db.ref('/phones').orderByKey().once('value');
  const phonesRaw = phonesSnap.val() || {};

  if (Object.keys(phonesRaw).length === 0) {
    console.log('⚠️  কোনো phone data পাওয়া যায়নি — খালি হোমপেজ generate করছি।');
  }

  const phoneList = Object.entries(phonesRaw).map(([firebaseKey, phone]) => ({
    id: parseInt(firebaseKey, 10) || firebaseKey,
    slug: phone.slug,
    name: phone.name || '',
    image: phone.img || '',
    price: phone.price || '',
    brand: phone.brand || '',
    budget_label: phone.budget_label || '',
    summary: phone.summary || phone.desc || '',
    created_at: phone.createdAt || 0,
  }));

  console.log(`✅ ${phoneList.length}টা ফোন পাওয়া গেছে।`);

  // created_at দিয়ে sort (নতুন আগে)
  const sorted = [...phoneList].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const totalPages = Math.ceil(sorted.length / PHONES_PER_PAGE) || 1;

  // ব্র্যান্ড chips — unique, নাম অনুযায়ী sort
  const brandNames = [...new Set(phoneList.map(p => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'bn'));
  const brandChips = brandNames
    .map(name => render(chipTemplate, { href: `/brands/${slugify(name)}.html`, label: escapeHtml(name) }))
    .join('');

  // বাজেট chips — Firebase-এ budget_label দেওয়া থাকলে সেখান থেকে, নাহলে ডিফল্ট রেঞ্জ
  const DEFAULT_BUDGET_RANGES = ['১০ হাজারের নিচে', '১০-২০ হাজার', '২০-৩০ হাজার', 'ফ্ল্যাগশিপ'];
  const budgetLabels = [...new Set(phoneList.map(p => p.budget_label).filter(Boolean))];
  const budgetChips = (budgetLabels.length ? budgetLabels : DEFAULT_BUDGET_RANGES)
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

// Main
(async () => {
  try {
    console.log('🚀 Script শুরু হয়েছে...');
    await generateHomepage();
    console.log('\n🎉 হোমপেজ generate হয়েছে!');
    await getApp().delete();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    await getApp().delete().catch(() => {});
    process.exit(1);
  }
})();
