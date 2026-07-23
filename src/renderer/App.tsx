export function App() {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">LAN companion</p>
          <h1>OpenClaude</h1>
        </div>
        <span className="status">连接器未就绪</span>
      </header>
      <section className="workspace">
        <aside className="sessions">
          <div className="section-heading"><h2>会话</h2><button aria-label="新建会话">+</button></div>
          <div className="empty-state">连接 Claude Desktop 后，会话会显示在这里。</div>
        </aside>
        <section className="conversation">
          <div className="conversation-header"><div><p className="eyebrow">当前工作区</p><h2>准备连接</h2></div><span className="chip">Claude Desktop</span></div>
          <div className="message-area"><p>先完成连接器配置，再从手机继续桌面端的任务。</p></div>
          <form className="composer" onSubmit={(event) => event.preventDefault()}>
            <textarea placeholder="输入要发送给 Claude Desktop 的内容" rows={3} />
            <button type="submit">发送</button>
          </form>
        </section>
      </section>
    </main>
  );
}
