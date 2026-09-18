import { useEffect, useState } from 'react';
import type { AnswerValue, InteractiveStep, Step } from '@funnel/shared';

/**
 * One component per step *type* (not per screen): texts, options, limits and messages all come from the config.
 * Adding a screen to a config therefore never needs frontend code; a new step type would (and would be
 * rejected by validateConfig until the renderer supports it).
 */

interface StepProps<S extends Step> {
  step: S;
  initial: AnswerValue | undefined;
  onSubmit: (value: AnswerValue | undefined) => void;
  onChange: () => void;
}

export function InfoStep({ step, onSubmit }: StepProps<Extract<Step, { type: 'info' }>>) {
  return (
    <div className="step">
      {step.content.eyebrow && <p className="eyebrow">{step.content.eyebrow}</p>}
      <h1>{step.content.title}</h1>
      {step.content.body && <p className="body">{step.content.body}</p>}
      <div className="actions">
        <button className="primary" autoFocus onClick={() => onSubmit(undefined)}>
          {step.content.primaryActionLabel ?? 'Continue'}
        </button>
      </div>
    </div>
  );
}

function Header({ step }: { step: InteractiveStep }) {
  return (
    <>
      <h1 id={`${step.id}-title`}>{step.content.title}</h1>
      {step.content.helperText && <p className="helper">{step.content.helperText}</p>}
    </>
  );
}

export function SingleSelectStep({ step, initial, onSubmit, onChange }: StepProps<Extract<Step, { type: 'single-select' }>>) {
  const [value, setValue] = useState<string | undefined>(typeof initial === 'string' ? initial : undefined);
  return (
    <form className="step" noValidate onSubmit={(e) => (e.preventDefault(), onSubmit(value))}>
      <Header step={step} />
      <div className="options" role="radiogroup" aria-labelledby={`${step.id}-title`}>
        {step.input.options.map((o) => (
          <label key={o.value} className={`option ${value === o.value ? 'selected' : ''}`}>
            <input
              type="radio"
              name={step.input.name}
              value={o.value}
              checked={value === o.value}
              onChange={() => (setValue(o.value), onChange())}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      <div className="actions">
        <button className="primary" type="submit">Continue</button>
      </div>
    </form>
  );
}

export function MultiSelectStep({ step, initial, onSubmit, onChange }: StepProps<Extract<Step, { type: 'multi-select' }>>) {
  const [values, setValues] = useState<string[]>(Array.isArray(initial) ? initial : []);
  const max = step.validation?.maxSelections;
  const toggle = (v: string) => {
    onChange();
    setValues((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  };
  return (
    <form className="step" noValidate onSubmit={(e) => (e.preventDefault(), onSubmit(values))}>
      <Header step={step} />
      <div className="options" role="group" aria-labelledby={`${step.id}-title`}>
        {step.input.options.map((o) => {
          const checked = values.includes(o.value);
          return (
            <label key={o.value} className={`option ${checked ? 'selected' : ''}`}>
              <input type="checkbox" value={o.value} checked={checked} onChange={() => toggle(o.value)} />
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>
      {max !== undefined && <p className="counter">{values.length} / {max} selected</p>}
      <div className="actions">
        <button className="primary" type="submit">Continue</button>
      </div>
    </form>
  );
}

export function NumberStep({ step, initial, onSubmit, onChange }: StepProps<Extract<Step, { type: 'number' }>>) {
  const [text, setText] = useState(typeof initial === 'number' ? String(initial) : '');
  useEffect(() => setText(typeof initial === 'number' ? String(initial) : ''), [step.id, initial]);
  return (
    <form className="step" noValidate onSubmit={(e) => (e.preventDefault(), onSubmit(text))}>
      <Header step={step} />
      <div className="number">
        <input
          aria-labelledby={`${step.id}-title`}
          type="number"
          inputMode="numeric"
          autoFocus
          min={step.input.min}
          max={step.input.max}
          step={step.input.step}
          value={text}
          onChange={(e) => (setText(e.target.value), onChange())}
        />
        {step.input.unit && <span className="unit">{step.input.unit}</span>}
      </div>
      <div className="actions">
        <button className="primary" type="submit">Continue</button>
      </div>
    </form>
  );
}
