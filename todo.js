// Simple Todo Scheduler with drag and drop

document.addEventListener('DOMContentLoaded', () => {
  const taskInput = document.getElementById('task-input');
  const inboxList = document.getElementById('inbox-list');
  const tomorrowList = document.getElementById('tomorrow-list');
  const nextWeekList = document.getElementById('nextweek-list');
  const weekDays = document.getElementById('week-days');
  const weekPrev = document.getElementById('week-prev');
  const weekNext = document.getElementById('week-next');
  const backlog = document.getElementById('backlog');

  let currentWeekStart = startOfWeek(new Date());
  let taskCounter = 0;
  const tasks = {};

  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && taskInput.value.trim()) {
      const id = `task-${taskCounter++}`;
      const li = document.createElement('li');
      li.textContent = taskInput.value.trim();
      li.className = 'task';
      li.id = id;
      li.draggable = true;
      li.dataset.list = 'inbox-list';
      li.addEventListener('dragstart', dragStart);
      tasks[id] = li;
      taskInput.value = '';
      renderTasks();
    }
  });

  function dragStart(e) {
    e.dataTransfer.setData('text/plain', e.target.id);
  }

  function setupDropZone(zone) {
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      const task = tasks[id];
      if (!task) return;
      if (zone.dataset.date) {
        task.dataset.date = zone.dataset.date;
        delete task.dataset.list;
      } else {
        task.dataset.list = zone.id;
        delete task.dataset.date;
      }
      renderTasks();
    });
  }

  function startOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function formatISO(date) {
    return date.toISOString().split('T')[0];
  }

  function renderWeek() {
    weekDays.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(currentWeekStart);
      dayDate.setDate(currentWeekStart.getDate() + i);
      const column = document.createElement('div');
      column.className = 'day';
      const header = document.createElement('div');
      header.className = 'day-header';
      header.textContent = dayDate.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const ul = document.createElement('ul');
      ul.className = 'drop-zone';
      ul.dataset.date = formatISO(dayDate);
      column.appendChild(header);
      column.appendChild(ul);
      weekDays.appendChild(column);
      setupDropZone(ul);
    }
    renderTasks();
  }

  weekPrev.addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    renderWeek();
  });

  weekNext.addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    renderWeek();
  });

  function renderTasks() {
    inboxList.innerHTML = '';
    tomorrowList.innerHTML = '';
    nextWeekList.innerHTML = '';
    document.querySelectorAll('#week-days ul').forEach((ul) => (ul.innerHTML = ''));
    backlog.innerHTML = '';

    Object.values(tasks).forEach((task) => {
      if (task.dataset.list) {
        const listZone = document.getElementById(task.dataset.list);
        if (listZone) listZone.appendChild(task);
        else backlog.appendChild(task);
      } else if (task.dataset.date) {
        const zone = document.querySelector(`#week-days ul[data-date="${task.dataset.date}"]`);
        if (zone) zone.appendChild(task);
        else backlog.appendChild(task);
      } else {
        inboxList.appendChild(task);
      }
    });
  }

  function setupStaticDates() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrowList.dataset.date = formatISO(tomorrow);

    const nextWeek = startOfWeek(new Date());
    nextWeek.setDate(nextWeek.getDate() + 7);
    nextWeekList.dataset.date = formatISO(nextWeek);
  }

  // Initialization
  [inboxList, tomorrowList, nextWeekList].forEach(setupDropZone);
  setupStaticDates();
  renderWeek();
  renderTasks();
});
