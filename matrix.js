const canvas = document.getElementById('matrix');
const ctx = canvas.getContext('2d');

function resize(){
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  columns = Math.floor(canvas.width / fontSize);
  drops = Array(columns).fill(0);
}
let fontSize = 16;
let columns = 0;
let drops = [];
const chars = 'アァカサタナハマヤャラワガザダバパイィキシチニヒミリヰギジヂビピウゥクスツヌフムユュルグズブプエェケセテネヘメレヱゲゼデベペオォコソトノホモヨョロゴゾドボポヴ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function draw(){
  ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#00ff66';
  ctx.font = `${fontSize}px monospace`;
  for(let i=0; i<drops.length; i++){
    const text = chars[Math.floor(Math.random()*chars.length)];
    const x = i * fontSize;
    const y = drops[i] * fontSize;
    ctx.fillText(text, x, y);

    if (y > canvas.height && Math.random() > 0.975){
      drops[i] = 0;
    }
    drops[i]++;
  }
  requestAnimationFrame(draw);
}

window.addEventListener('resize', resize);
resize();
draw();

const titleEl = document.getElementById('title');
const countEl = document.getElementById('count');

function show(el){ el.classList.remove('hidden'); el.classList.add('show'); }
function hide(el){ el.classList.remove('show'); el.classList.add('hidden'); }

setTimeout(()=>{
  show(titleEl);
  setTimeout(()=>{
    hide(titleEl);
    let n = 5;
    countEl.textContent = n;
    show(countEl);
    const tick = setInterval(()=>{
      n--;
      if (n <= 0){
        countEl.textContent = '1';
        setTimeout(()=>{
          document.body.style.background = '#001a0f';
          countEl.textContent = 'LAUNCH';
          countEl.style.fontSize = 'clamp(64px, 18vw, 260px)';
        }, 200);
        clearInterval(tick);
      } else {
        countEl.textContent = String(n);
      }
    }, 700);
  }, 1200);
}, 2000);
