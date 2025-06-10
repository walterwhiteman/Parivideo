/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}", // Scan all JS/JSX/TS/TSX files in the src folder
    "./public/index.html" // Also scan index.html for classes
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
