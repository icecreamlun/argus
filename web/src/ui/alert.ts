/**
 * ShakeAlert banner, modelled on the USGS ShakeAlert / MyShake alert: high contrast, protective action
 * ("Drop, Cover, Hold On"), a big countdown to strong shaking and the expected intensity.
 */
import { h, replayClass, setText } from './dom';
import { icon } from './icons';
import { mmiLevel } from './format';

const RING_R = 27;
const RING_C = 2 * Math.PI * RING_R;

export function createShakeAlert() {
  const ringFg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('viewBox', '0 0 64 64');
  ring.setAttribute('class', 'ag-alert__ring');
  ring.setAttribute('aria-hidden', 'true');
  ring.innerHTML = `<circle cx="32" cy="32" r="${RING_R}" class="ag-alert__ring-bg"/>`;
  for (const [k, v] of Object.entries({ cx: '32', cy: '32', r: String(RING_R), class: 'ag-alert__ring-fg', 'stroke-dasharray': String(RING_C), 'stroke-dashoffset': '0' })) ringFg.setAttribute(k, v);
  ring.append(ringFg);

  const num = h('span', { class: 'ag-alert__num' }, '0');
  const unit = h('span', { class: 'ag-alert__unit' }, 'sec');
  const nowWave = h('span', { class: 'ag-alert__now' }, icon('wave'));
  const count = h('div', { class: 'ag-alert__count' }, ring, h('div', { class: 'ag-alert__countText' }, num, unit), nowWave);

  const kicker = h('span', { class: 'ag-alert__kicker' }, 'Earthquake');
  const title = h('div', { class: 'ag-alert__title' }, 'Drop, Cover, Hold On');
  const sub = h('div', { class: 'ag-alert__sub' }, '');
  const actions = h(
    'div',
    { class: 'ag-alert__actions' },
    h('span', { class: 'ag-alert__act' }, icon('drop'), 'Drop'),
    h('span', { class: 'ag-alert__act' }, icon('cover'), 'Cover'),
    h('span', { class: 'ag-alert__act' }, icon('hold'), 'Hold on'),
  );
  const mmiChip = h('span', { class: 'ag-alert__mmiChip' }, 'VIII');
  const mmiWord = h('span', { class: 'ag-alert__mmiWord' }, 'Severe');
  const mmi = h('div', { class: 'ag-alert__mmi' }, h('span', { class: 'ag-alert__mmiLabel' }, 'Expected'), mmiChip, mmiWord);

  const el = h(
    'div',
    { class: 'ag-alert', role: 'alert', 'aria-live': 'assertive', hidden: true },
    h('div', { class: 'ag-alert__pulse', 'aria-hidden': 'true' }),
    h('div', { class: 'ag-alert__head' }, icon('alert', 'ag-alert__headIco'), kicker, h('span', { class: 'ag-alert__src' }, 'USGS ShakeAlert')),
    h('div', { class: 'ag-alert__body' }, count, h('div', { class: 'ag-alert__msg' }, title, sub, actions), mmi),
  );

  let visible = false;
  let hideTimer = 0;
  let initial = 0;
  let lastWhole = Number.NaN;
  let mode: 'countdown' | 'now' | null = null;

  return {
    el,
    get visible() {
      return visible;
    },
    show(seconds: number, expectedMmi: number) {
      window.clearTimeout(hideTimer);
      if (!visible) {
        visible = true;
        initial = Math.max(seconds, 1);
        lastWhole = Number.NaN;
        mode = null;
        el.hidden = false;
        el.classList.remove('is-leaving');
        replayClass(el, 'is-entering');
      }
      const lvl = mmiLevel(expectedMmi);
      if (mmiChip.textContent !== lvl.roman || mmiChip.style.background === '') {
        setText(mmiChip, lvl.roman);
        mmiChip.style.background = lvl.color;
        mmiChip.style.color = lvl.ink;
        setText(mmiWord, lvl.shaking);
      }

      const nextMode = seconds > 0 ? 'countdown' : 'now';
      if (nextMode !== mode) {
        mode = nextMode;
        el.dataset.mode = mode;
        setText(kicker, mode === 'countdown' ? 'Earthquake' : 'Shaking now');
        setText(title, 'Drop, Cover, Hold On');
      }
      if (mode === 'countdown') {
        const whole = Math.ceil(seconds);
        if (whole !== lastWhole) {
          lastWhole = whole;
          setText(num, String(whole));
          setText(sub, `${lvl.shaking} shaking expected in ${whole} second${whole === 1 ? '' : 's'}`);
          replayClass(num, 'is-tick');
        }
        ringFg.setAttribute('stroke-dashoffset', (RING_C * (1 - Math.max(0, Math.min(1, seconds / initial)))).toFixed(1));
      } else {
        setText(sub, 'Protect yourself now. Stay put until the shaking stops.');
      }
    },
    hide() {
      if (!visible) return;
      visible = false;
      el.classList.remove('is-entering');
      el.classList.add('is-leaving');
      hideTimer = window.setTimeout(() => {
        el.hidden = true;
        el.classList.remove('is-leaving');
      }, 450);
    },
  };
}
