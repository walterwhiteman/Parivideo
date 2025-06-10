import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // Import our global CSS (which includes Tailwind)
import App from './App'; // Import our main App component

// Create a root for rendering your React app
const root = ReactDOM.createRoot(document.getElementById('root'));

// Render the App component inside the root
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
