const screenEl = document.getElementById('screen');
const inputEl = document.getElementById('input');
const formEl = document.getElementById('input-form');
const cursorEl = document.querySelector('.cursor');
const quickLinksEl = document.getElementById('quick-links');

const STORAGE_KEYS = { bookmarks:'ronny_term_bookmarks', theme:'ronny_term_theme' };

function loadBookmarks(){ try{ const raw = localStorage.getItem(STORAGE_KEYS.bookmarks); const arr = raw? JSON.parse(raw): []; return Array.isArray(arr)? arr: [] }catch{ return [] } }
function saveBookmarks(list){ localStorage.setItem(STORAGE_KEYS.bookmarks, JSON.stringify(list)); renderQuickLinks(); }
function loadTheme(){ return localStorage.getItem(STORAGE_KEYS.theme) || 'green'; }
function saveTheme(t){ localStorage.setItem(STORAGE_KEYS.theme, t); }
function setTheme(t){ const root = document.documentElement; root.classList.remove('theme-green','theme-amber','theme-phosphor'); const map = { green:'theme-green', amber:'theme-amber', phosphor:'theme-phosphor' }; root.classList.add(map[t]||'theme-green'); saveTheme(t); }

function renderQuickLinks(){
  const list = loadBookmarks();
  quickLinksEl.innerHTML = '';
  list.slice(0,4).forEach(bm => {
    const a = document.createElement('a');
    a.href = bm.url; a.target = '_blank'; a.rel='noopener'; a.className='btn-link';
    a.textContent = `[ ${bm.name.toUpperCase()} ]`;
    quickLinksEl.appendChild(a);
  });
}

const measure = (() => {
  const ghost = document.createElement('span');
  ghost.style.visibility='hidden'; ghost.style.position='absolute'; ghost.style.whiteSpace='pre';
  ghost.style.fontFamily=getComputedStyle(inputEl).fontFamily; ghost.style.fontSize=getComputedStyle(inputEl).fontSize;
  document.body.appendChild(ghost);
  return (text) => { ghost.textContent = text.replace(/ /g, '\u00A0'); return ghost.getBoundingClientRect().width; };
})();

function updateCursor(){
  const val = inputEl.value.slice(0, inputEl.selectionStart || inputEl.value.length);
  const width = measure(val);
  cursorEl.style.transform = `translateX(${width}px)`;
}

let history = []; let hIndex = -1;
let lampsMode = false; let lampsPrevTheme = null;
function print(html){ const line = document.createElement('pre'); line.className='line'; line.innerHTML = html; screenEl.appendChild(line); screenEl.scrollTop = screenEl.scrollHeight; }
function printPrompt(cmd){ const p = document.createElement('pre'); p.className='line'; p.innerHTML = `<span class="prompt">ronny@home:~$</span> ${cmd}`; screenEl.appendChild(p); }
function parseArgs(str){ const re = /"([^"]+)"|(\S+)/g; const out=[]; let m; while((m=re.exec(str))) out.push(m[1]||m[2]); return out; }

function helpText(){ return [
  "Available commands:",
  "  help                 - show this message",
  "  about                - who dis",
  "  projects             - things I'm into",
  "  contact              - how to reach me",
  "  links                - example links",
  "  clear                - clear the screen",
  "  ",
  "  # Bookmarks (persist via localStorage)",
  "  bookmarks            - list your bookmarks",
  "  addbm NAME URL       - add a bookmark (use quotes for spaces)",
  "  rmbm INDEX           - remove bookmark by index (see list)",
  "  open INDEX           - open bookmark in new tab",
  "  clearbm              - remove ALL bookmarks",
  "  exportbm             - print bookmarks JSON to copy",
  "  importbm JSON        - paste JSON to replace bookmarks",
  "  ",
  "  # Theme",
  "  theme green|amber|phosphor",
  "  (Secret) Click [ LAMPS TEST ] to switch to amber instantly."
].join('\n'); }

const commands = {
  help(){ print(helpText()); },
  about(){ print(`Name: Ronny
AKA: Big dawg, Pimp, etc.
Bio: Safety specialist, tinkerer, musician, maker.`); },
  projects(){ print(`Projects:
 - Home automation & sensors
 - Raspberry Pi + ESP32 builds
 - Photography & creative stuff`); },
  contact(){ print(`Contact:
  email: <a class="inline" href="mailto:ronny@example.com">ronny@example.com</a>
  github: <a class="inline" href="https://github.com/" target="_blank" rel="noopener">github.com/</a>`); },
  links(){ print(`Links:
  - <a class="inline" href="https://example.com" target="_blank" rel="noopener">Example</a>
  - <a class="inline" href="https://thepihut.com" target="_blank" rel="noopener">Pi Hut</a>
  - <a class="inline" href="https://obsidian.md" target="_blank" rel="noopener">Obsidian</a>`); },
  clear(){ screenEl.innerHTML=''; },

  bookmarks(){
    const list = loadBookmarks();
    if (!list.length){ print('No bookmarks yet. Add one with: addbm "Name" https://site.com'); return; }
    print(list.map((bm,i)=>`${i+1}. ${bm.name} — ${bm.url}`).join('\n'));
  },
  addbm(...args){
    const parsed = parseArgs(args.join(' '));
    if (parsed.length < 2){ print('Usage: addbm "Name" https://url'); return; }
    const [name, url] = parsed;
    const list = loadBookmarks(); list.push({name, url}); saveBookmarks(list);
    print(`Added: ${name} — ${url}`);
  },
  rmbm(idxStr){
    const idx = parseInt(idxStr,10);
    const list = loadBookmarks();
    if (isNaN(idx) || idx < 1 || idx > list.length){ print('Usage: rmbm INDEX (see "bookmarks")'); return; }
    const removed = list.splice(idx-1,1)[0]; saveBookmarks(list);
    print(`Removed: ${removed.name}`);
  },
  open(idxStr){
    const idx = parseInt(idxStr,10); const list = loadBookmarks();
    if (isNaN(idx) || idx < 1 || idx > list.length){ print('Usage: open INDEX (see "bookmarks")'); return; }
    const bm = list[idx-1]; window.open(bm.url,'_blank','noopener'); print(`Opening: ${bm.name} — ${bm.url}`);
  },
  clearbm(){ saveBookmarks([]); print('All bookmarks cleared.'); },
  exportbm(){ print(JSON.stringify(loadBookmarks())); },
  importbm(...args){
    try{ const data = JSON.parse(args.join(' ')); if (!Array.isArray(data)) throw 0; saveBookmarks(data); print(`Imported ${data.length} bookmarks.`); }
    catch{ print('Import failed. Paste valid JSON array.'); }
  },

  theme(choice){
    const t = (choice||'').toLowerCase();
    if (!['green','amber','phosphor'].includes(t)){ print('Usage: theme green|amber|phosphor'); return; }
    setTheme(t); print(`Theme set to ${t}.`);
  }
};

function handleCommand(raw){
  const trimmed = raw.trim(); if (!trimmed) return;
  const [name, ...rest] = trimmed.split(/\s+/);
  const cmd = name.toLowerCase();
  (commands[cmd] || (()=>print(`Command not found: ${cmd}. Type <span class="cmd">help</span>.`)))(...rest);
}

formEl.addEventListener('submit', (e)=>{
  e.preventDefault();
  const cmd = inputEl.value;
  printPrompt(cmd);
  history.unshift(cmd); hIndex = -1;
  handleCommand(cmd);
  inputEl.value = ""; updateCursor();
});

inputEl.addEventListener('keydown', (e)=>{
  if (e.key === 'ArrowUp'){ e.preventDefault(); if (history.length && hIndex < history.length-1){ hIndex++; inputEl.value = history[hIndex]; updateCursor(); } }
  else if (e.key === 'ArrowDown'){ e.preventDefault(); if (hIndex > 0){ hIndex--; inputEl.value = history[hIndex]; } else { hIndex=-1; inputEl.value=""; } updateCursor(); }
});
inputEl.addEventListener('input', updateCursor);
inputEl.addEventListener('click', updateCursor);
window.addEventListener('resize', updateCursor);

document.querySelectorAll('[data-theme]').forEach(btn=>{
  btn.addEventListener('click', (e)=>{ e.preventDefault(); setTheme(btn.getAttribute('data-theme')); });
});

// Secret button -> amber
document.addEventListener('DOMContentLoaded', ()=>{
  const lamps = document.getElementById('lamps-test');
  if (lamps){
    lamps.addEventListener('click', (e)=>{
      e.preventDefault();
      if (!lampsMode){
        lampsPrevTheme = loadTheme();
        setTheme('amber');
        print('Diagnostics: amber phosphor engaged.');
      } else {
        setTheme(lampsPrevTheme || 'green');
        print('Diagnostics: original phosphor restored.');
      }
      lampsMode = !lampsMode;
    });
  }
});

setTheme(loadTheme()||'green');
renderQuickLinks();
updateCursor();

if (loadBookmarks().length === 0){
  saveBookmarks([
    { name: "Obsidian", url: "https://obsidian.md" },
    { name: "GitHub", url: "https://github.com" },
    { name: "Home Assistant", url: "https://www.home-assistant.io" },
    { name: "Pi Hut", url: "https://thepihut.com" }
  ]);
  print('Seeded sample bookmarks. Use addbm/rmbm/bookmarks to customize.');
}
