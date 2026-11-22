// Offline, deterministic transliteration of Devanagari (Hindi) and Kannada text into casual Roman letters.
// No network, no dependencies. Word by word: the caller keeps each word's timing, only its text changes.
// Style: readable everyday spelling ("mera naam", "nanna hesaru"), not scholarly diacritics.

const DEV = {
  ind: { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ऍ': 'e', 'ए': 'e', 'ऐ': 'ai', 'ऑ': 'o', 'ओ': 'o', 'औ': 'au' },
  mat: { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'ॅ': 'e', 'े': 'e', 'ै': 'ai', 'ॉ': 'o', 'ो': 'o', 'ौ': 'au' },
  cons: { 'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l' },
  nukta: { 'क': 'k', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f' },
  nuktaChar: '\u093C', virama: '\u094D', anus: 'ं', chandra: 'ँ', visarga: 'ः', dropFinalA: true,
  digits: '०१२३४५६७८९', danda: { '।': '.', '॥': '.' },
};
const KAN = {
  ind: { 'ಅ': 'a', 'ಆ': 'aa', 'ಇ': 'i', 'ಈ': 'ee', 'ಉ': 'u', 'ಊ': 'oo', 'ಋ': 'ru', 'ಎ': 'e', 'ಏ': 'e', 'ಐ': 'ai', 'ಒ': 'o', 'ಓ': 'o', 'ಔ': 'au' },
  mat: { 'ಾ': 'a', 'ಿ': 'i', 'ೀ': 'i', 'ು': 'u', 'ೂ': 'u', 'ೃ': 'ru', 'ೆ': 'e', 'ೇ': 'e', 'ೈ': 'ai', 'ೊ': 'o', 'ೋ': 'o', 'ೌ': 'au' },
  cons: { 'ಕ': 'k', 'ಖ': 'kh', 'ಗ': 'g', 'ಘ': 'gh', 'ಙ': 'n', 'ಚ': 'ch', 'ಛ': 'chh', 'ಜ': 'j', 'ಝ': 'jh', 'ಞ': 'n',
    'ಟ': 't', 'ಠ': 'th', 'ಡ': 'd', 'ಢ': 'dh', 'ಣ': 'n', 'ತ': 't', 'ಥ': 'th', 'ದ': 'd', 'ಧ': 'dh', 'ನ': 'n',
    'ಪ': 'p', 'ಫ': 'ph', 'ಬ': 'b', 'ಭ': 'bh', 'ಮ': 'm', 'ಯ': 'y', 'ರ': 'r', 'ಱ': 'r', 'ಲ': 'l', 'ವ': 'v', 'ಶ': 'sh', 'ಷ': 'sh', 'ಸ': 's', 'ಹ': 'h', 'ಳ': 'l' },
  nukta: {}, nuktaChar: null, virama: '\u0CCD', anus: 'ಂ', chandra: 'ಁ', visarga: 'ಃ', dropFinalA: false,
  digits: '೦೧೨೩೪೫೬೭೮೯', danda: { '।': '.', '॥': '.' },
};
const SCRIPTS = [DEV, KAN];
const SCRIPT_RE = /[\u0900-\u097F\u0C80-\u0CFF]/;


// Everyday Kanglish spellings for very common words (checked first; anything else uses the letter rules above)
const KN_WORDS = {"ನಾನು": "naanu", "ನೀನು": "neenu", "ನೀವು": "neevu", "ಅವನು": "avanu", "ಅವಳು": "avalu", "ಅವರು": "avaru", "ನಾವು": "naavu", "ನಮ್ಮ": "namma", "ನನ್ನ": "nanna", "ನಿನ್ನ": "ninna", "ನಿಮ್ಮ": "nimma", "ಇದು": "idu", "ಅದು": "adu", "ಏನು": "enu", "ಯಾರು": "yaaru", "ಎಲ್ಲಿ": "elli", "ಯಾಕೆ": "yaake", "ಹೇಗೆ": "hege", "ಎಷ್ಟು": "eshtu", "ಯಾವಾಗ": "yaavaga", "ಇಲ್ಲ": "illa", "ಹೌದು": "haudu", "ಸರಿ": "sari", "ಚೆನ್ನಾಗಿ": "chennagi", "ಚೆನ್ನಾಗಿದೆ": "chennagide", "ಮಾಡಿ": "maadi", "ಮಾಡು": "maadu", "ಮಾಡ್ತೀನಿ": "maadtini", "ಬನ್ನಿ": "banni", "ಬಾ": "baa", "ಹೋಗಿ": "hogi", "ಹೋಗು": "hogu", "ಬೇಕು": "beku", "ಬೇಡ": "beda", "ಗೊತ್ತು": "gottu", "ಅಂದ್ರೆ": "andre", "ಆದ್ರೆ": "aadre", "ಮತ್ತು": "mattu", "ಆಮೇಲೆ": "aamele", "ಈಗ": "iga", "ಇವತ್ತು": "ivattu", "ನಾಳೆ": "naale", "ನಿನ್ನೆ": "ninne", "ಜನ": "jana", "ವಿಡಿಯೋ": "video", "ಸಾಫ್ಟ್‌ವೇರ್": "software", "ಕನ್ನಡ": "kannada", "ಧನ್ಯವಾದ": "dhanyavaada", "ಧನ್ಯವಾದಗಳು": "dhanyavaadagalu", "ಎಲ್ಲರಿಗೂ": "ellarigu", "ಎಲ್ಲಾ": "ella", "ತುಂಬಾ": "tumba", "ಸ್ವಲ್ಪ": "swalpa", "ಒಂದು": "ondu", "ಎರಡು": "eradu", "ಮೂರು": "mooru", "ನಾಲ್ಕು": "naalku", "ಐದು": "aidu", "ಹೌದಾ": "haudaa", "ಅಲ್ಲ": "alla", "ಇರಲಿ": "irali", "ಇದೆ": "ide", "ಇದ್ದೀನಿ": "iddini", "ಹೇಳಿ": "heli", "ನೋಡಿ": "nodi", "ನೋಡು": "nodu", "ಕೇಳಿ": "keli", "ಬರ್ತೀನಿ": "bartini"};
function romanWord(word, T) {
  if (T === KAN) { const core = word.replace(/[.,!?;:"'।]+$/u, ''); const hit = KN_WORDS[core]; if (hit) return hit + word.slice(core.length); }
  const toks = [];
  for (const ch of Array.from(word)) {
    const last = toks[toks.length - 1];
    if (T.nuktaChar && ch === T.nuktaChar && last && last.k === 'c') { last.r = T.nukta[last.base] || last.r; continue; }
    if (T.cons[ch] !== undefined) toks.push({ k: 'c', r: T.cons[ch], base: ch });
    else if (T.ind[ch] !== undefined) toks.push({ k: 'v', r: T.ind[ch] });
    else if (T.mat[ch] !== undefined) toks.push({ k: 'm', r: T.mat[ch] });
    else if (ch === T.virama) toks.push({ k: 'vir' });
    else if (ch === T.anus || ch === T.chandra) toks.push({ k: 'anus', r: 'n' });
    else if (ch === T.visarga) toks.push({ k: 'x', r: 'h' });
    else if (T.digits.includes(ch)) toks.push({ k: 'x', r: String(T.digits.indexOf(ch)) });
    else if (T.danda[ch]) toks.push({ k: 'x', r: T.danda[ch] });
    else toks.push({ k: 'x', r: ch });
  }
  const letters = (i) => toks.slice(i).some(t => t.k === 'c' || t.k === 'v' || t.k === 'm');
  let out = '', lastDel = false;
  const kCons = toks.filter(t => t.k === 'c').length;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], nx = toks[i + 1];
    if (t.k === 'c') {
      if (nx && nx.k === 'vir') { // conjunct: the first consonant loses its vowel
        const after = toks[i + 2];
        // achha (च्छ), not chhchha: an aspirate after its plain form takes the sound alone
        if (after && after.k === 'c' && after.r.length > t.r.length && after.r.startsWith(t.r)) continue;
        out += t.r; i++; continue;
      }
      if (nx && nx.k === 'm') { // consonant with a vowel sign
        let v = nx.r;
        if (T.dropFinalA && v === 'ee' && !letters(i + 2)) v = 'i'; // final ī: jee -> ji, hindi
        if (T.dropFinalA && v === 'aa' && !letters(i + 2)) v = 'a';
        if (T.dropFinalA && v === 'aa' && kCons >= 3) v = 'a';                                                     // long words: hamara, dhanyavad (short ones keep kaam, naam)                                                         // final ā: mera, raha
        if (T.dropFinalA && v === 'ee' && toks[i + 2] && toks[i + 2].k === 'anus') v = 'i';                                  // nahīṃ -> nahin
        if (v === 'e' && toks[i + 2] && toks[i + 2].k === 'anus') { out += t.r + (letters(i + 3) ? 'en' : 'ein'); i += 2; continue; }  // में -> mein, but केंद्रक -> kendrak
        out += t.r + v; i++; continue;
      }
      // Hindi schwa deletion (apane -> apne, sakate -> sakte, rahata -> rahta): a middle consonant before a consonant that has a vowel sign
      if (T.dropFinalA && i > 0 && !lastDel && toks[i - 1].k !== 'vir' && toks[i - 1].k !== 'anus' && nx && nx.k === 'c' && toks[i + 2] && toks[i + 2].k === 'm') { out += t.r; lastDel = true; continue; }
      lastDel = false;
      if (letters(i + 1)) out += t.r + 'a';                       // inherent vowel before another letter
      else out += T.dropFinalA ? t.r : t.r + 'a';                 // word-final: Hindi drops it (naam), Kannada keeps it (kannada)
      continue;
    }
    if (t.k === 'v') { let v = t.r; if (T.dropFinalA && v === 'aa' && !letters(i + 1)) v = 'a'; out += v; continue; }
    if (t.k === 'm') { out += t.r; continue; }
    if (t.k === 'anus' || t.k === 'x') { out += t.r; continue; }
    // stray virama: nothing
  }
  return out;
}

// Convert native-script text to Roman letters. Words are split on whitespace so spacing survives.
export function romanize(text) {
  if (!text || !SCRIPT_RE.test(text)) return text;
  const T = SCRIPTS.find(S => Array.from(text).some(ch => S.cons[ch] !== undefined || S.ind[ch] !== undefined));
  if (!T) return text;
  return text.replace(/[^\s]+/g, w => romanWord(w, T));
}

// Words from the speech worker: { t, s, e } — same timings, Roman text.
export function romanizeWords(words) {
  return words.map(w => ({ ...w, t: romanize(w.t) }));
}

// r127e: 'Kannada + English': Kannada words stay in Kannada letters, common English words said inside Kannada go back to English letters
const MIX = {"ಪ್ರಾಡಕ್ಟ್": "product", "ಪ್ರೊಡಕ್ಟ್": "product", "ಪ್ರಾಡೆಕ್ಟ್": "product", "ಪ್ರಾಡೆಕ್ಸ್": "product", "ಪ್ರಾಡಕ್ಟ್ಸ್": "product", "ಪ್ರೊಡಕ್ಟ್ಸ್": "product", "ಪ್ರೋಡಕ್ಟ್": "product", "ಕ್ವಾಲಿಟಿ": "quality", "ಕ್ವಾಲಿಟೀ": "quality", "ಪ್ರೀಮಿಯಂ": "premium", "ಪ್ರೀಮಿಯಮ್": "premium", "ಪ್ರೀಮಿಯಮ್ಮ": "premium", "ರಾ ಮೆಟೀರಿಯಲ್ಸ್": "raw material", "ರಾ ಮೆಟೀರಿಯಲ್": "raw material", "ರಾಮೆಟೀರಿಯಲ್ಸ್": "raw material", "ರಾ ಮೆಟಿರಿಯಲ್ಸ್": "raw material", "ಮೆಟೀರಿಯಲ್": "material", "ಮೆಟೀರಿಯಲ್ಸ್": "material", "ಮೆಟಿರಿಯಲ್ಸ್": "material", "ಮೆಟಿರಿಯಲ್": "material", "ಫೈನಲ್": "final", "ಕಾಂಟಾಕ್ಟ್": "contact", "ಕಾಂಟ್ಯಾಕ್ಟ್": "contact", "ಕಾಂಟೆಕ್ಟ್": "contact", "ಕಾಮನ್ ಮಿಸ್ಟೇಕ್ಸ್": "common mistakes", "ಮಿಸ್ಟೇಕ್": "mistake", "ಮಿಸ್ಟೇಕ್ಸ್": "mistake", "ಕಾಮನ್": "common", "ಇಂಪಾರ್ಟೆನ್ಸ್": "importance", "ಇಂಪಾರ್ಟೆಂಟ್": "important", "ಪ್ಯೂರಿಟಿ": "purity", "ಸ್ಟಾರ್ಟಿಂಗ್": "starting", "ಸ್ಟಾರ್ಟ್": "start", "ವಿಡಿಯೋ": "video", "ವೀಡಿಯೋ": "video", "ಸಾಫ್ಟ್‌ವೇರ್": "software", "ಸಾಫ್ಟ್ವೇರ್": "software", "ಆಪ್": "app", "ಆ್ಯಪ್": "app", "ಫ್ರೀ": "free", "ಪೇಯ್ಡ್": "paid", "ಲಿಂಕ್": "link", "ಬಯೋ": "bio", "ಸಬ್ಸ್ಕ್ರೈಬ್": "subscribe", "ಲೈಕ್": "like", "ಶೇರ್": "share", "ಕಾಮೆಂಟ್": "comment", "ರೀಲ್": "reel", "ರೀಲ್ಸ್": "reel", "ಇನ್ಸ್ಟಾಗ್ರಾಮ್": "instagram", "ಇನ್ಸ್ಟಾಗ್ರಾಂ": "instagram", "ಯೂಟ್ಯೂಬ್": "youtube", "ಫೋನ್": "phone", "ಫೋನು": "phone", "ಮೊಬೈಲ್": "mobile", "ಮೊಬೈಲು": "mobile", "ಬಿಸಿನೆಸ್": "business", "ಬಿಸ್ನೆಸ್": "business", "ಕಸ್ಟಮರ್": "customer", "ಕಸ್ಟಮರ್ಸ್": "customer", "ಸರ್ವೀಸ್": "service", "ಪ್ರೈಸ್": "price", "ಆಫರ್": "offer", "ಡಿಸ್ಕೌಂಟ್": "discount", "ಡಿಸೈನ್": "design", "ಬ್ರಾಂಡ್": "brand", "ಬ್ರ್ಯಾಂಡ್": "brand", "ಕಂಪನಿ": "company", "ಕಂಪೆನಿ": "company", "ಆಫೀಸ್": "office", "ಸ್ಟೋರ್": "store", "ಶಾಪ್": "shop", "ಶೋರೂಮ್": "showroom", "ಶೋ ರೂಮ್": "showroom", "ಫರ್ನಿಚರ್": "furniture", "ಫರ್ನೀಚರ್": "furniture", "ವುಡ್": "wood", "ಸೋಫಾ": "sofa", "ಬೆಡ್": "bed", "ಟೇಬಲ್": "table", "ಚೇರ್": "chair", "ಡೆಲಿವರಿ": "delivery", "ಆರ್ಡರ್": "order", "ಆನ್ಲೈನ್": "online", "ಆನ್‌ಲೈನ್": "online", "ಆಫ್ಲೈನ್": "offline", "ಇಂಟರ್ನೆಟ್": "internet", "ಎಡಿಟ್": "edit", "ಎಡಿಟಿಂಗ್": "editing", "ಎಡಿಟರ್": "editor", "ಸಬ್ಟೈಟಲ್": "subtitle", "ಸಬ್‌ಟೈಟಲ್": "subtitle", "ಕ್ಯಾಪ್ಷನ್": "caption", "ಕ್ಯಾಪ್ಶನ್": "caption", "ಅಪ್ಡೇಟ್": "update", "ಡೌನ್ಲೋಡ್": "download", "ಡೌನ್‌ಲೋಡ್": "download", "ಇನ್ಸ್ಟಾಲ್": "install", "ಪ್ಲಾನ್": "plan", "ಬಜೆಟ್": "budget", "ಟೀಮ್": "team", "ವರ್ಕ್": "work", "ಪ್ರಾಜೆಕ್ಟ್": "project", "ಪ್ರೊಜೆಕ್ಟ್": "project", "ಗುಡ್": "good", "ಬೆಸ್ಟ್": "best", "ಸೂಪರ್": "super", "ಸರ್": "sir", "ಮೇಡಂ": "madam", "ಥ್ಯಾಂಕ್ ಯು": "thank you", "ಥ್ಯಾಂಕ್ಯೂ": "thank you", "ಹಲೋ": "hello", "ಹೆಲೋ": "hello", "ಓಕೆ": "okay", "ಒಕೆ": "okay", "ಪ್ಲೀಸ್": "please", "ಸಾರಿ": "sorry", "ಪ್ರಾಬ್ಲಂ": "problem", "ಪ್ರಾಬ್ಲಮ್": "problem", "ಟೈಮ್": "time", "ನಂಬರ್": "number", "ಹೈ": "high", "ಲೋ": "low", "ನ್ಯೂ": "new", "ರೆಡಿ": "ready", "ಚೆಕ್": "check", "ಸೈಜ್": "size", "ಕಲರ್": "colour", "ಮಾಡೆಲ್": "model", "ಮಾಡೆಲ್ಸ್": "model"};
const MIX_SUF = ["ನಲ್ಲಿ", "ಅಲ್ಲಿ", "ಗೆ", "ಅನ್ನು", "ಇಂದ", "ದ", "ನ", "ಅಲ್ಲ", "ಯ", "ಯನ್ನು"];
export function mixEnglish(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], bare = w.t.replace(/[.,!?;:]+$/u, ''), tail = w.t.slice(bare.length);
    // two-word phrases first (raw materials, common mistakes, thank you)
    const nx = words[i + 1];
    if (nx) { const two = bare + ' ' + nx.t.replace(/[.,!?;:]+$/u, ''); const hit2 = MIX[two]; if (hit2) { out.push({ ...w, t: hit2 + nx.t.slice(nx.t.replace(/[.,!?;:]+$/u, '').length), e: nx.e }); i++; continue; } }
    let hit = MIX[bare], suf = '';
    if (!hit) for (const s of MIX_SUF) if (bare.endsWith(s) && bare.length > s.length + 2 && MIX[bare.slice(0, -s.length)]) { hit = MIX[bare.slice(0, -s.length)]; suf = s; break; }
    out.push(hit ? { ...w, t: hit + (suf ? ' ' + suf : '') + tail } : w);
  }
  return out;
}

// r127f: known mis-hearings of English words said inside Kannada are corrected to one standard Kannada spelling (applies to Kannada, Kannada + English and Kanglish)
const LOAN_FIX = {"ಪ್ರೊಡಕ್ಟ್": "ಪ್ರಾಡಕ್ಟ್", "ಪ್ರಾಡೆಕ್ಟ್": "ಪ್ರಾಡಕ್ಟ್", "ಪ್ರಾಡೆಕ್ಸ್": "ಪ್ರಾಡಕ್ಟ್", "ಪ್ರಾಡಕ್ಟ್ಸ್": "ಪ್ರಾಡಕ್ಟ್", "ಪ್ರೊಡಕ್ಟ್ಸ್": "ಪ್ರಾಡಕ್ಟ್", "ಪ್ರೋಡಕ್ಟ್": "ಪ್ರಾಡಕ್ಟ್", "ಕ್ವಾಲಿಟೀ": "ಕ್ವಾಲಿಟಿ", "ಪ್ರೀಮಿಯಮ್": "ಪ್ರೀಮಿಯಂ", "ಪ್ರೀಮಿಯಮ್ಮ": "ಪ್ರೀಮಿಯಂ", "ರಾಮೆಟೀರಿಯಲ್ಸ್": "ರಾ ಮೆಟೀರಿಯಲ್ಸ್", "ಮೆಟೀರಿಯಲ್ಸ್": "ಮೆಟೀರಿಯಲ್", "ಮೆಟಿರಿಯಲ್ಸ್": "ಮೆಟೀರಿಯಲ್", "ಮೆಟಿರಿಯಲ್": "ಮೆಟೀರಿಯಲ್", "ಕಾಂಟ್ಯಾಕ್ಟ್": "ಕಾಂಟಾಕ್ಟ್", "ಕಾಂಟೆಕ್ಟ್": "ಕಾಂಟಾಕ್ಟ್", "ಕಾಂಟಾಕ್ಟ್": "ಕಾಂಟಾಕ್ಟ್", "ಮಿಸ್ಟೇಕ್ಸ್": "ಮಿಸ್ಟೇಕ್", "ಇಂಪಾರ್ಟೆನ್ಸ್": "ಇಂಪಾರ್ಟೆನ್ಸ್", "ವೀಡಿಯೋ": "ವಿಡಿಯೋ", "ಸಾಫ್ಟ್ವೇರ್": "ಸಾಫ್ಟ್‌ವೇರ್", "ಆ್ಯಪ್": "ಆಪ್", "ರೀಲ್ಸ್": "ರೀಲ್", "ಇನ್ಸ್ಟಾಗ್ರಾಂ": "ಇನ್ಸ್ಟಾಗ್ರಾಮ್", "ಫೋನು": "ಫೋನ್", "ಮೊಬೈಲು": "ಮೊಬೈಲ್", "ಬಿಸ್ನೆಸ್": "ಬಿಸಿನೆಸ್", "ಕಸ್ಟಮರ್ಸ್": "ಕಸ್ಟಮರ್", "ಬ್ರ್ಯಾಂಡ್": "ಬ್ರಾಂಡ್", "ಕಂಪೆನಿ": "ಕಂಪನಿ", "ಫರ್ನೀಚರ್": "ಫರ್ನಿಚರ್", "ಆನ್‌ಲೈನ್": "ಆನ್ಲೈನ್", "ಸಬ್‌ಟೈಟಲ್": "ಸಬ್ಟೈಟಲ್", "ಕ್ಯಾಪ್ಶನ್": "ಕ್ಯಾಪ್ಷನ್", "ಡೌನ್‌ಲೋಡ್": "ಡೌನ್ಲೋಡ್", "ಪ್ರೊಜೆಕ್ಟ್": "ಪ್ರಾಜೆಕ್ಟ್", "ಥ್ಯಾಂಕ್ಯೂ": "ಥ್ಯಾಂಕ್ ಯು", "ಹೆಲೋ": "ಹಲೋ", "ಒಕೆ": "ಓಕೆ", "ಪ್ರಾಬ್ಲಮ್": "ಪ್ರಾಬ್ಲಂ", "ಮಾಡೆಲ್ಸ್": "ಮಾಡೆಲ್", "ಪ್ರಾಡೆಕ್ಸ್ನ": "ಪ್ರಾಡಕ್ಟ್ನ", "ಪ್ರಾಡೆಕ್ಟ್ನ": "ಪ್ರಾಡಕ್ಟ್ನ", "ಪ್ರಾಡೆಕ್ಟ್ನಲ್ಲಿ": "ಪ್ರಾಡಕ್ಟ್ನಲ್ಲಿ", "ಎಂಪೆಕ್ಸ್ನಲ್ಲಿ": "ಪ್ರಾಡಕ್ಟ್ನಲ್ಲಿ", "ಪ್ರಾಡೆಕ್ಟ್ಸ್": "ಪ್ರಾಡಕ್ಟ್ಸ್", "ಪ್ರೀಮಿಯಮ್ಮಾಗು": "ಪ್ರೀಮಿಯಂ ಆಗಿ", "ಮ್ಯಾನಿಯಾಕ್ಷರ್": "ಮ್ಯಾನುಫ್ಯಾಕ್ಚರ್"};
export function fixLoans(words) {
  return words.map(w => { const bare = w.t.replace(/[.,!?;:]+$/u, ''); const f = LOAN_FIX[bare]; return f ? { ...w, t: f + w.t.slice(bare.length) } : w; });
}

// r127g: 'Hindi + English': Hindi stays in Devanagari, common English words said inside Hindi go back to English letters
const MIX_HI = {"प्रोडक्ट": "product", "प्रोडक्ट्स": "products", "क्वालिटी": "quality", "प्रीमियम": "premium", "मटेरियल": "material", "रॉ मटेरियल": "raw material", "कॉन्टैक्ट": "contact", "कांटेक्ट": "contact", "फाइनल": "final", "वीडियो": "video", "वीडियोज़": "videos", "सॉफ्टवेयर": "software", "सॉफ़्टवेयर": "software", "ऐप": "app", "एप": "app", "एप्प": "app", "फ्री": "free", "पेड": "paid", "लिंक": "link", "बायो": "bio", "सब्सक्राइब": "subscribe", "लाइक": "like", "शेयर": "share", "कमेंट": "comment", "रील": "reel", "रील्स": "reels", "इंस्टाग्राम": "instagram", "यूट्यूब": "youtube", "फोन": "phone", "मोबाइल": "mobile", "बिज़नेस": "business", "बिजनेस": "business", "कस्टमर": "customer", "सर्विस": "service", "प्राइस": "price", "ऑफर": "offer", "डिस्काउंट": "discount", "डिज़ाइन": "design", "डिजाइन": "design", "ब्रांड": "brand", "कंपनी": "company", "ऑफिस": "office", "स्टोर": "store", "शॉप": "shop", "शोरूम": "showroom", "फर्नीचर": "furniture", "डिलीवरी": "delivery", "ऑर्डर": "order", "ऑनलाइन": "online", "ऑफलाइन": "offline", "इंटरनेट": "internet", "एडिट": "edit", "एडिटिंग": "editing", "एडिटर": "editor", "सबटाइटल": "subtitle", "कैप्शन": "caption", "अपडेट": "update", "डाउनलोड": "download", "इंस्टॉल": "install", "प्लान": "plan", "बजट": "budget", "टीम": "team", "वर्क": "work", "प्रोजेक्ट": "project", "गुड": "good", "बेस्ट": "best", "सुपर": "super", "सर": "sir", "मैडम": "madam", "थैंक यू": "thank you", "हेलो": "hello", "हैलो": "hello", "ओके": "okay", "प्लीज़": "please", "प्लीज": "please", "सॉरी": "sorry", "प्रॉब्लम": "problem", "टाइम": "time", "नंबर": "number", "हाई": "high", "न्यू": "new", "रेडी": "ready", "चेक": "check", "साइज़": "size", "साइज": "size", "कलर": "colour", "मॉडल": "model", "स्टार्ट": "start", "स्टार्टिंग": "starting", "कॉमन": "common", "मिस्टेक": "mistake", "इम्पोर्टेंट": "important", "इंपोर्टेंट": "important", "इम्पोर्टेंस": "importance", "प्योरिटी": "purity", "कंटेंट": "content", "क्रिएटर": "creator", "टिप्स": "tips", "ट्यूटोरियल": "tutorial", "फीचर": "feature", "फीचर्स": "features", "सेटिंग": "setting", "सेटिंग्स": "settings", "अकाउंट": "account", "पासवर्ड": "password", "लॉगिन": "login", "वेबसाइट": "website", "ईमेल": "email", "मैसेज": "message", "कॉल": "call", "व्हाट्सएप": "whatsapp", "फेसबुक": "facebook", "गूगल": "google", "वायरल": "viral", "ट्रेंड": "trend", "ट्रेंडिंग": "trending", "फॉलो": "follow", "फॉलोअर्स": "followers", "चैनल": "channel", "लाइव": "live", "स्टोरी": "story", "पोस्ट": "post", "हैशटैग": "hashtag", "क्लिक": "click", "बटन": "button", "स्क्रीन": "screen", "कंप्यूटर": "computer", "लैपटॉप": "laptop", "विंडोज": "windows", "एक्सपोर्ट": "export", "रेंडर": "render", "रेंडरिंग": "rendering", "एफेक्ट": "effect", "इफेक्ट": "effect", "इफेक्ट्स": "effects", "म्यूजिक": "music", "ऑडियो": "audio", "स्पीड": "speed", "फास्ट": "fast", "स्लो": "slow", "सिंपल": "simple", "इजी": "easy", "प्रो": "pro", "स्टाइल": "style", "स्टाइल्स": "styles", "फ़ॉन्ट": "font", "फॉन्ट": "font"};
const MIX_HI_SUF = ["को", "का", "की", "के", "में", "से", "पर", "ने", "भी"];
export function mixEnglishHi(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], bare = w.t.replace(/[.,!?;:।]+$/u, ''), tail = w.t.slice(bare.length), nx = words[i + 1];
    if (nx) { const nb = nx.t.replace(/[.,!?;:।]+$/u, ''); const h2 = MIX_HI[bare + ' ' + nb]; if (h2) { out.push({ ...w, t: h2 + nx.t.slice(nb.length), e: nx.e }); i++; continue; } }
    let hit = MIX_HI[bare], suf = '';
    if (!hit) for (const s of MIX_HI_SUF) if (bare.endsWith(s) && bare.length > s.length + 2 && MIX_HI[bare.slice(0, -s.length)]) { hit = MIX_HI[bare.slice(0, -s.length)]; suf = s; break; }
    out.push(hit ? { ...w, t: hit + (suf ? ' ' + suf : '') + tail } : w);
  }
  return out;
}

// r127h: very common Hindi words get their everyday Hinglish spelling (checked before the letter rules)
const HI_WORDS = {"नहीं": "nahi", "है": "hai", "हैं": "hain", "मैं": "main", "कैसे": "kaise", "आप": "aap", "आपको": "aapko", "दोस्तों": "doston", "धन्यवाद": "dhanyavaad", "नमस्ते": "namaste", "बहुत": "bahut", "अच्छा": "accha", "अच्छी": "acchi", "अच्छे": "acche", "बिल्कुल": "bilkul", "क्या": "kya", "और": "aur", "यह": "yeh", "ये": "ye", "वो": "woh", "कि": "ki", "की": "ki", "का": "ka", "के": "ke", "को": "ko", "में": "mein", "से": "se", "पर": "par", "भी": "bhi", "तो": "toh", "हम": "hum", "आज": "aaj", "कल": "kal", "अब": "ab", "फिर": "phir", "लेकिन": "lekin", "क्योंकि": "kyunki", "कीमत": "keemat", "पसंद": "pasand", "ज़रूर": "zaroor", "जरूर": "zaroor", "मेरा": "mera", "मेरी": "meri", "हमारा": "hamara", "आपका": "aapka", "आपकी": "aapki", "कर": "kar", "करें": "karein", "करो": "karo", "करना": "karna", "देखिए": "dekhiye", "देखो": "dekho", "बताइए": "bataiye", "बताओ": "batao", "चाहिए": "chahiye", "सकते": "sakte", "सकता": "sakta", "रहा": "raha", "रही": "rahi", "लिए": "liye", "साथ": "saath", "सब": "sab", "कुछ": "kuch", "कोई": "koi", "बस": "bas", "एक": "ek", "दो": "do", "तीन": "teen", "चार": "chaar", "पांच": "paanch", "ठीक": "theek", "सही": "sahi", "बढ़िया": "badhiya", "भाई": "bhai", "यार": "yaar"};
export function hinglishWords(words) {
  return words.map(w => { const bare = w.t.replace(/[.,!?;:।]+$/u, ''); const h = HI_WORDS[bare]; return h ? { ...w, t: h + w.t.slice(bare.length) } : w; });
}
