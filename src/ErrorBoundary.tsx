import { Component, type ErrorInfo, type ReactNode } from "react";
import "./error-boundary.css";

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error("界面遇到了无法显示的数据。") };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Listing Studio 界面错误", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-error-boundary" role="alert">
        <h1>界面出错了</h1>
        <p>请重新加载页面恢复工作台。如果有生成任务正在运行，恢复后请先查看运行记录，避免重复提交。</p>
        <details>
          <summary>错误摘要</summary>
          <pre>{this.state.error.message.slice(0, 600)}</pre>
        </details>
        <button type="button" className="primary-button" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </main>
    );
  }
}
