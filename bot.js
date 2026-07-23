// Diplomacia Otomatik Bot - Bulut (GitHub Actions) sürümü
// Tampermonkey userscript'i ile AYNI mantığı kullanır, tek seferlik (bir kez /work bir kez /profile
// ziyaret eder) çalışacak şekilde uyarlanmıştır. GitHub Actions bunu periyodik olarak tetikler.

const { chromium } = require('playwright');
const fs = require('fs');

// ================= GÜVENLİK =================
// Bu kelimelerden biri geçen HİÇBİR elemana asla basılmaz.
const KUYERSEL_YASAK = ['premium', 'satın al', 'satin al', 'iptal', 'ödeme', 'odeme', 'kart bilgisi', 'abonelik', 'jeton al', 'elmas al'];
// ==============================================

// ================= ÇALIŞMA PROGRAMI =================
// 3 saat aktif, 1 saat tamamen pasif, döngü tekrar eder — BOTUN İLK ÇALIŞTIĞI ANDAN İTİBAREN
// sayılır (sabit saat bloklarına göre değil). Bu yüzden başlangıç zamanı state.json dosyasına
// yazılır ve workflow tarafından repoya geri commit edilir (GitHub Actions her çalıştırmada
// hafızasını sıfırladığı için kalıcı bir yere yazmamız gerekiyor).
const AKTIF_SURE_MS = 3 * 60 * 60 * 1000;
const PASIF_SURE_MS = 1 * 60 * 60 * 1000;
const STATE_PATH = 'state.json';

function zamanDurumunuYukleVeyaOlustur() {
  let veri = null;
  try {
    veri = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    veri = null;
  }
  if (!veri || !veri.cevrimBaslangici) {
    veri = { cevrimBaslangici: new Date().toISOString() };
    fs.writeFileSync(STATE_PATH, JSON.stringify(veri, null, 2) + '\n');
    log('İlk çalıştırma: çalışma programı başlangıcı kaydedildi ->', veri.cevrimBaslangici);
  }
  return veri;
}

function botAktifMi() {
  // 3s/1s programı kapatıldı — cron-job.org zaten 15 dakikada bir güvenilir şekilde
  // tetiklediği için ayrıca bir aktif/pasif pencereye gerek yok, bot her tetiklendiğinde çalışır.
  return true;
}
// ======================================================

function log(...a) {
  console.log('[DiploBot]', ...a);
}

// Kullanıcının tarayıcısından dışa aktarılan çerezleri Playwright'ın beklediği formata çevirir.
// Cookie-Editor, DevTools ve benzer araçların farklı alan adlarını (expirationDate/expires,
// sameSite değerleri) tolere eder.
function playwrightCerezlerineCevir(raw) {
  const sameSiteMap = { no_restriction: 'None', unspecified: 'Lax', lax: 'Lax', strict: 'Strict', none: 'None' };
  return raw.map((c) => {
    let sameSite = c.sameSite;
    if (typeof sameSite === 'string') {
      const key = sameSite.toLowerCase();
      sameSite = sameSiteMap[key] || (['Strict', 'Lax', 'None'].includes(sameSite) ? sameSite : 'Lax');
    } else {
      sameSite = 'Lax';
    }
    let expires = c.expires;
    if (expires === undefined) expires = c.expirationDate;
    if (expires === undefined || c.session) expires = -1;
    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires,
      httpOnly: !!c.httpOnly,
      secure: c.secure !== undefined ? !!c.secure : true,
      sameSite,
    };
  });
}

// ---- Aşağıdaki fonksiyonlar sayfa (tarayıcı) içinde çalışır: page.evaluate() ile enjekte edilir ----
// Tampermonkey script'indeki mantığın birebir aynısı.
function sayfaIciYardimcilar() {
  const norm = (s) =>
    (s || '')
      .toLocaleLowerCase('tr-TR')
      .replace(/ı/g, 'i')
      .replace(/\s+/g, ' ')
      .trim();

  const sadeceHarfCekirdek = (s) => norm(s).replace(/[^a-zçğıöşü ]+/gi, '').trim();

  function adaylar() {
    return Array.from(document.querySelectorAll('[tabindex="0"], button, [role="button"]'));
  }
  function gorunur(el) {
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch (e) {}
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const ekranGenislik = window.innerWidth || document.documentElement.clientWidth;
    const ekranYukseklik = window.innerHeight || document.documentElement.clientHeight;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= ekranGenislik || r.top >= ekranYukseklik) return false;
    return true;
  }
  function solukMu(el) {
    return parseFloat(getComputedStyle(el).opacity || '1') < 0.5;
  }
  function guvenliMi(t) {
    return !window.__KUYERSEL_YASAK.some((k) => t.includes(norm(k)));
  }
  function kapaliMi(el) {
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    if (getComputedStyle(el).pointerEvents === 'none') return true;
    if (solukMu(el)) return true;
    const zamanDeseni = /\b\d{1,2}:\d{2}\b|\b\d+\s*(dk|dakika|sn|saniye)\b/i;
    const kaldiKelime = /(kald[ıi]|kalan)/i;
    let node = el;
    for (let i = 0; i < 3 && node; i++) {
      const txt = node.innerText || node.textContent || '';
      if (zamanDeseni.test(txt) && kaldiKelime.test(txt)) return true;
      node = node.parentElement;
    }
    return false;
  }
  function ustSoyle(el, derinlik, ariyor) {
    let node = el;
    for (let i = 0; i < derinlik && node; i++) {
      node = node.parentElement;
      if (node && norm(node.textContent).includes(ariyor)) return true;
    }
    return false;
  }
  function enKucukMetinEslesmesi(kelimelerHam, haricHam, etiketHam) {
    const kelimeler = (kelimelerHam || []).map(norm);
    const haric = (haricHam || []).map(norm);
    const etiket = etiketHam ? norm(etiketHam) : '';
    let enIyi = null;
    let enKucukUzunluk = Infinity;
    const tumElemanlar = document.body.querySelectorAll('*');
    for (const el of tumElemanlar) {
      if (!gorunur(el)) continue;
      const tHam = norm(el.innerText || el.textContent);
      if (!tHam) continue;
      if (tHam.length >= enKucukUzunluk) continue;
      if (!guvenliMi(tHam)) continue;
      if (!kelimeler.every((k) => tHam.includes(k))) continue;
      if (haric.some((h) => tHam.includes(h))) continue;
      if (etiket && !ustSoyle(el, 8, etiket)) continue;
      enKucukUzunluk = tHam.length;
      enIyi = el;
    }
    return enIyi;
  }
  function enYakinTiklanabilir(el) {
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      if (node.tagName === 'BUTTON' || node.getAttribute?.('role') === 'button' || node.getAttribute?.('tabindex') === '0') {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }
  function tamEslesenButon(kelimeHam) {
    const hedef = norm(kelimeHam);
    return (
      adaylar().find((el) => {
        if (!gorunur(el)) return false;
        const tHam = norm(el.innerText || el.textContent);
        if (!tHam || !guvenliMi(tHam)) return false;
        return sadeceHarfCekirdek(tHam) === hedef;
      }) || null
    );
  }
  function gercektenTikla(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    const d = (t, C) => {
      try {
        el.dispatchEvent(new C(t, o));
      } catch (e) {}
    };
    d('pointerdown', PointerEvent);
    d('mousedown', MouseEvent);
    d('pointerup', PointerEvent);
    d('mouseup', MouseEvent);
    d('click', MouseEvent);
  }
  function yukseltmeDevamMi() {
    return Array.from(document.querySelectorAll('div')).some(
      (el) => gorunur(el) && norm(el.innerText || el.textContent).includes('geliştiriliyor')
    );
  }

  window.__diplo = {
    norm, sadeceHarfCekirdek, adaylar, gorunur, solukMu, guvenliMi, kapaliMi, ustSoyle,
    enKucukMetinEslesmesi, enYakinTiklanabilir, tamEslesenButon, gercektenTikla, yukseltmeDevamMi,
  };
}

async function calisSayfasiniIsle(page) {
  return page.evaluate(() => {
    const h = window.__diplo;
    const rapor = { calisTiklandi: false, odulKapatildi: false, teshis: {} };

    const calisBtn = h.tamEslesenButon('çalış');
    rapor.teshis.calisBtnBulundu = !!calisBtn;
    if (calisBtn) {
      rapor.teshis.calisBtnMetin = (calisBtn.innerText || calisBtn.textContent || '').trim();
      rapor.teshis.calisBtnKapaliMi = h.kapaliMi(calisBtn);
    }
    // Tam eşleşme bulunamadıysa, "çalış" geçen tüm aday elemanları da raporla (teşhis için)
    if (!calisBtn) {
      rapor.teshis.calisGecenAdaylar = h
        .adaylar()
        .filter((el) => h.gorunur(el) && h.norm(el.innerText || el.textContent).includes('çaliş'))
        .map((el) => ({
          metin: (el.innerText || el.textContent || '').trim().slice(0, 60),
          kapaliMi: h.kapaliMi(el),
        }))
        .slice(0, 5);
    }

    if (calisBtn && !h.kapaliMi(calisBtn)) {
      h.gercektenTikla(calisBtn);
      rapor.calisTiklandi = true;
    }

    const harikaBtn = h.tamEslesenButon('harika');
    if (harikaBtn) {
      h.gercektenTikla(harikaBtn);
      rapor.odulKapatildi = true;
    }

    return rapor;
  });
}

async function profilSayfasiniIsle(page) {
  // Her GitHub Actions çalıştırması sıfırdan yeni bir tarayıcı açar (önceki çalıştırmadan
  // DOM/UI durumu KALMAZ) — bu yüzden "Kışla" satırı her seferinde kapalı başlar.
  // Aynı çalıştırma içinde: satır kapalıysa aç -> kısa bekle (DOM güncellensin) -> PARA'ya bas.
  return page.evaluate(async () => {
    const h = window.__diplo;
    const rapor = { yukseltmeDevamEdiyordu: false, satirSecildi: false, paraTiklandi: false };
    const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

    if (h.yukseltmeDevamMi()) {
      rapor.yukseltmeDevamEdiyordu = true;
      return rapor; // İPTAL ET dahil hiçbir şeye dokunma
    }

    function paraButonuBul() {
      const paraMetinEl = h.enKucukMetinEslesmesi(['para', 'seviye'], ['elmas'], 'kışla');
      return paraMetinEl ? h.enYakinTiklanabilir(paraMetinEl) : null;
    }

    let paraBtn = paraButonuBul();

    if (!paraBtn) {
      // Satır kapalı olabilir, açmayı dene
      const satirMetinEl = h.enKucukMetinEslesmesi(['kışla'], ['seviyeniz', 'para', 'elmas'], '');
      const satirBtn = satirMetinEl ? h.enYakinTiklanabilir(satirMetinEl) : null;
      if (satirBtn) {
        h.gercektenTikla(satirBtn);
        rapor.satirSecildi = true;
        await bekle(1500); // DOM güncellensin (PARA/ELMAS kartları render olsun)
        paraBtn = paraButonuBul();
      }
    }

    if (paraBtn && !h.kapaliMi(paraBtn)) {
      h.gercektenTikla(paraBtn);
      rapor.paraTiklandi = true;
    }
    return rapor;
  });
}

async function run() {
  if (!botAktifMi()) {
    log('Çalışma programı: şu an PASİF saatteyiz (3s aktif / 1s pasif döngüsü). Tarayıcı açılmadan çıkılıyor.');
    return;
  }

  // Bu site oturumu COOKIE ile değil localStorage ile tutuyor (Cookie-Editor "çerez yok" gösterdi).
  // Bu yüzden asıl kimlik doğrulama verisi DIPLOMACIA_STORAGE secret'ından (localStorage JSON'u,
  // diplomacia.com.tr sayfasında konsola "copy(JSON.stringify(localStorage))" yazılarak alınır).
  // DIPLOMACIA_COOKIES varsa (opsiyonel) o da ayrıca eklenir, yoksa sorun değil.
  const storageRaw = process.env.DIPLOMACIA_STORAGE;
  if (!storageRaw) {
    console.error('HATA: DIPLOMACIA_STORAGE ortam değişkeni / secret bulunamadı.');
    process.exit(1);
  }
  let storageData;
  try {
    storageData = JSON.parse(storageRaw);
  } catch (e) {
    console.error('HATA: DIPLOMACIA_STORAGE geçerli bir JSON değil.', e.message);
    process.exit(1);
  }

  let cookies = [];
  const cookiesRaw = process.env.DIPLOMACIA_COOKIES;
  if (cookiesRaw) {
    try {
      cookies = playwrightCerezlerineCevir(JSON.parse(cookiesRaw));
    } catch (e) {
      log('UYARI: DIPLOMACIA_COOKIES geçerli bir JSON değil, çerezler atlanıyor.', e.message);
    }
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  if (cookies.length) await context.addCookies(cookies);
  const page = await context.newPage();
  await page.addInitScript(sayfaIciYardimcilar);
  await page.addInitScript((yasakli) => {
    window.__KUYERSEL_YASAK = yasakli;
  }, KUYERSEL_YASAK);

  try {
    log('Oturum (localStorage) yükleniyor...');
    await page.goto('https://diplomacia.com.tr/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate((data) => {
      for (const [k, v] of Object.entries(data)) {
        try { localStorage.setItem(k, v); } catch (e) {}
      }
    }, storageData);

    log('İş sayfasına gidiliyor...');
    await page.goto('https://diplomacia.com.tr/work', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);
    const isRaporu = await calisSayfasiniIsle(page);
    log('İş sayfası sonucu:', JSON.stringify(isRaporu));

    log('Profil sayfasına gidiliyor...');
    await page.goto('https://diplomacia.com.tr/profile', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);
    const profilRaporu = await profilSayfasiniIsle(page);
    log('Profil sayfası sonucu:', JSON.stringify(profilRaporu));

    // Giriş gerçekten geçerli mi kontrolü (basit bir ipucu): sayfa "giriş yap" gibi bir şey içeriyorsa uyar.
    const girisGecerliMi = await page.evaluate(() => {
      const t = (document.body.innerText || '').toLocaleLowerCase('tr-TR');
      return !t.includes('giriş yap') && !t.includes('oturum aç');
    });
    if (!girisGecerliMi) {
      console.error('UYARI: Oturum bilgisi (DIPLOMACIA_STORAGE) geçersiz/süresi dolmuş olabilir — giriş ekranı görünüyor gibi. localStorage değerini yenileyip Secret\'ı güncellemen gerekebilir.');
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
