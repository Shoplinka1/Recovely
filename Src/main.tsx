import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Recovely frontend render failure', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className='boot boot-error'>
        <div className='mark'>R</div>
        <h1>Recovely could not load this screen.</h1>
        <p>Nothing was lost. Reload the app to try again.</p>
        <button className='btn primary' onClick={() => window.location.reload()}>Reload Recovely</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
