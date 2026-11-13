import { heroui } from '@heroui/react'

// Relay reference palette: cobalt accents, cool white and deep navy surfaces.
const blue = {
  50: '#eef5ff',
  100: '#dceaff',
  200: '#bbd5ff',
  300: '#91baff',
  400: '#609dff',
  500: '#3184ff',
  600: '#2674eb',
  700: '#205dbe',
  800: '#1f4c94',
  900: '#1a3765'
}

export default heroui({
  themes: {
    light: {
      colors: {
        background: '#f2f6fc',
        foreground: '#182b49',
        content1: '#ffffff',
        content2: '#eaf1fb',
        content3: '#dce7f6',
        content4: '#cbd9ed',
        divider: '#c5d4e8',
        focus: '#2674eb',
        primary: { ...blue, DEFAULT: '#2674eb', foreground: '#ffffff' },
        default: {
          50: '#f6f9fe',
          100: '#eaf0f9',
          200: '#d7e2f1',
          300: '#bacce2',
          400: '#839ab7',
          500: '#5d7594',
          600: '#425c7c',
          700: '#304a6b',
          800: '#223a59',
          900: '#172b46',
          DEFAULT: '#d7e2f1',
          foreground: '#182b49'
        }
      }
    },
    dark: {
      colors: {
        background: '#14213b',
        foreground: '#f4f7ff',
        content1: '#1d2e4b',
        content2: '#263a5b',
        content3: '#334c70',
        content4: '#425e86',
        divider: '#405b80',
        focus: '#91baff',
        primary: {
          50: blue[900],
          100: blue[800],
          200: blue[700],
          300: blue[600],
          400: blue[500],
          500: blue[400],
          600: blue[300],
          700: blue[200],
          800: blue[100],
          900: blue[50],
          DEFAULT: '#3184ff',
          foreground: '#ffffff'
        },
        default: {
          50: '#192a45',
          100: '#213451',
          200: '#304768',
          300: '#476185',
          400: '#849abc',
          500: '#acbdd7',
          600: '#c4d1e5',
          700: '#dbe4f2',
          800: '#eaf0fa',
          900: '#f4f7ff',
          DEFAULT: '#304768',
          foreground: '#f4f7ff'
        }
      }
    }
  }
})
