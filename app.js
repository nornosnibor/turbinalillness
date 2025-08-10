// ===== Retro Terminal Logic =====
const screenEl = document.getElementById('screen');
const inputEl = document.getElementById('input');
const formEl = document.getElementById('input-form');
const cursorEl = document.querySelector('.cursor');

// Keep the "cursor" synced to input caret by measuring text width.
const measure = (() => {
  const ghost = document.createElement('span');
  ghost.style.visibility = 'hidden';
  ghost.style.position = 'absolute';
  ghost.style.whiteSpace = 'pre';
  ghost.style.fontFamily = getComputedStyle(inputEl).fontFamily;
  ghost.style.fontSize = getComputedStyle(inputEl).fontSize;
  document.body.appendChild(ghost);
  return (text) => {
    ghost.textContent = text.replace(/ /g, '\u00A0');
    const rect = ghost.getBoundingClientRect();
    return rect.width;
  };
})();

function updateCursor(){
  const val = inputEl.value;
  const width = measure(val);
  cursorEl.style.transform = `translateX(${width}px)`;
}

// history
let history = [];
let hIndex = -1;

// commands
const commands = {
  help(){
    print([
      "Available commands:",
      "  help        - show this message",
      "  about       - who dis",
      "  projects    - things I'm into",
      "  contact     - how to reach me",
      "  links       - clickable links",
      "  clear       - clear the screen"
    ].join('\n'));
  },
  about(){
    print(`Name: Ronny
AKA: Big dawg, Pimp, etc.
Bio: Safety specialist, tinkerer, musician, maker.`);
  },
  projects(){
    print(`Projects:
 - Home automation & sensors
 - Raspberry Pi + ESP32 builds
 - Photography & creative stuff`);
  },
  contact(){
    print(`Contact:
  email: <a class="inline" href="mailto:ronny@example.com">ronny@example.com</a>
  github: <a class="inline" href="https://github.com/" target="_blank" rel="noopener">github.com/</a>`);
  },
  links(){
    print(`Links:
  - <a class="inline" href="https://example.com" target="_blank" rel="noopener">Example</a>
  - <a class="inline" href="https://thepihut.com" target="_blank" rel="noopener">Pi Hut</a>
  - <a class="inline" href="https://obsidian.md" target="_blank" rel="noopener">Obsidian</a>`);
  },
  clear(){
    screenEl.innerHTML = "";
  }
};

function print(html){
  const line = document.createElement('pre');
  line.className = 'line';
  line.innerHTML = html;
  screenEl.appendChild(line);
  screenEl.scrollTop = screenEl.scrollHeight;
}

function printPrompt(cmd){
  const prompt = document.createElement('pre');
  prompt.className = 'line';
  prompt.innerHTML = `<span class="prompt">ronny@home:~$</span> ${cmd}`;
  screenEl.appendChild(prompt);
}

function handleCommand(cmd){
  const name = cmd.trim().split(/\s+/)[0].toLowerCase();
  if (name.length === 0) return;
  if (commands[name]){
    commands[name]();
  } else {
    print(`Command not found: ${name}. Type <span class="cmd">help</span>.`);
  }
}

// submit
formEl.addEventListener('submit', (e)=>{
  e.preventDefault();
  const cmd = inputEl.value;
  printPrompt(cmd);
  history.unshift(cmd);
  hIndex = -1;
  handleCommand(cmd);
  inputEl.value = "";
  updateCursor();
});

// keyboard handlers for history
inputEl.addEventListener('keydown', (e)=>{
  if (e.key === 'ArrowUp'){
    e.preventDefault();
    if (history.length && hIndex < history.length - 1){
      hIndex++;
      inputEl.value = history[hIndex];
      updateCursor();
    }
  } else if (e.key === 'ArrowDown'){
    e.preventDefault();
    if (hIndex > 0){
      hIndex--;
      inputEl.value = history[hIndex];
    } else {
      hIndex = -1;
      inputEl.value = "";
    }
    updateCursor();
  }
});

// sync cursor as user types / clicks
inputEl.addEventListener('input', updateCursor);
inputEl.addEventListener('click', updateCursor);
window.addEventListener('resize', updateCursor);

// Quick link buttons fire commands
document.querySelectorAll('.btn-link').forEach(a => {
  a.addEventListener('click', (e)=>{
    e.preventDefault();
    const cmd = a.dataset.cmd;
    printPrompt(cmd);
    commands[cmd]?.();
  });
});

// initial cursor
updateCursor();
