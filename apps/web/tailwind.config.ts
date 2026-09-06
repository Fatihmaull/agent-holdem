import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        felt: {
          DEFAULT: '#0d2a20',
          light: '#15503a',
          rail: '#0f3d2c',
        },
        slate: {
          950: '#070b14',
        },
        // One accent per word-limit room, reused everywhere that room appears.
        micro: '#22d3ee',
        tactical: '#a78bfa',
        deep: '#fbbf24',
      },
      fontFamily: {
        display: ['Georgia', 'Times New Roman', 'serif'],
      },
      boxShadow: {
        felt: 'inset 0 0 120px rgba(0,0,0,0.55)',
        card: '0 8px 24px -8px rgba(0,0,0,0.7)',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(56,189,248,0.55)' },
          '70%': { boxShadow: '0 0 0 12px rgba(56,189,248,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(56,189,248,0)' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.8s ease-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
