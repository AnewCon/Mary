import { useCallback, useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';

type Review = {id:string;title:string;summary:string;lessons:string;nextSteps:string;createdAt:string};
export default function PaperReviews({api}:{api:(path:string)=>Promise<unknown>}) {
  const [reviews,setReviews] = useState<Review[]>();
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try { setReviews(await api('/paper/reviews') as Review[]); }
    catch { setError(true); }
    finally { setLoading(false); }
  },[api]);
  useEffect(() => { void load(); },[load]);

  return <section className="panel exchange-panel paper-reviews">
    <div className="panelhead"><div><h2><BookOpen size={17}/>币安交易复盘</h2>
      <p>在 Chat 里说「结束并复盘，保存到 QuantOS」。</p></div>
      <button type="button" onClick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新复盘'}</button>
    </div>
    <div className="exchange-body">
      {error && <p role="alert">暂时无法读取复盘，请重试。</p>}
      {!loading && !error && reviews?.length === 0 && <p>还没有保存的复盘。</p>}
      {reviews?.map(review => <details className="paper-review" key={review.id}>
        <summary><strong>{review.title}</strong><small>{new Date(review.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）</small></summary>
        <h3>交易回顾</h3><p>{review.summary}</p>
        <h3>经验与问题</h3><p>{review.lessons}</p>
        <h3>下次改进</h3><p>{review.nextSteps}</p>
      </details>)}
    </div>
  </section>;
}
