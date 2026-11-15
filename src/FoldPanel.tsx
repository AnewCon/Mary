import { useId, useState, type ReactNode } from 'react';

export default function FoldPanel({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="panel fold-panel">
    <h2><button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span>{title}</span><span className="fold-label">{open ? '收起 −' : '展开 +'}</span>
    </button></h2>
    <div id={id} className="fold-content" hidden={!open}>{open && children}</div>
  </section>;
}
