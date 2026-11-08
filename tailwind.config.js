/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./*.js",
  ],
  theme: {
    extend: {
      colors: {
        // --- Identidad Brote: oscuro, natural, alto contraste ---
        // Todos definidos como "rgb(R G B / <alpha-value>)" para que los
        // modificadores de opacidad de Tailwind (ej. text-ink/40) funcionen
        // correctamente incluso siendo colores personalizados.

        // "paper" = superficies (antes claro, ahora la base oscura de la app)
        paper: {
          DEFAULT: "rgb(7 12 9 / <alpha-value>)",    // fondo de página
          100: "rgb(15 22 17 / <alpha-value>)",        // tarjetas / paneles
          200: "rgb(22 32 25 / <alpha-value>)",        // superficie elevada / inputs
        },
        // "ink" = texto y bordes sutiles (antes oscuro sobre claro, ahora
        // claro sobre oscuro — por eso ink/10, ink/40, etc. siguen leyéndose
        // bien sin tocar el HTML)
        ink: {
          DEFAULT: "rgb(236 242 236 / <alpha-value>)", // texto principal
          900: "rgb(236 242 236 / <alpha-value>)",
          700: "rgb(191 201 191 / <alpha-value>)",       // texto secundario
          500: "rgb(142 156 142 / <alpha-value>)",
        },
        // "void" = negro real, para overlays de modal y fondo de cámara
        // (lo único que necesita quedarse oscuro incluso invirtiendo ink/paper)
        void: "rgb(2 6 4 / <alpha-value>)",

        // "teal" = acento primario (verde)
        teal: {
          DEFAULT: "rgb(196 181 253 / <alpha-value>)", // lila claro (acento)
          600: "rgb(167 139 250 / <alpha-value>)",       // lila para hover
          700: "rgb(233 225 255 / <alpha-value>)", // variante clara, para texto sobre fondo oscuro
        },
        // "marigold" = acento secundario (lima)
        marigold: {
          DEFAULT: "rgb(163 230 53 / <alpha-value>)",
          600: "rgb(132 204 22 / <alpha-value>)",
        },
        // "coral" = estados de error/peligro
        coral: "rgb(255 107 129 / <alpha-value>)",
      },
      fontFamily: {
        display: ['"Sora"', "sans-serif"],
        body: ["Inter", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      borderRadius: { xl2: "1.5rem" },
      boxShadow: {
        glow: "0 0 0 1px rgb(196 181 253 / 0.4), 0 0 24px 0 rgb(196 181 253 / 0.35)",
        card: "0 1px 0 0 rgb(255 255 255 / 0.04) inset, 0 8px 24px -12px rgb(0 0 0 / 0.6)",
      },
    },
  },
  plugins: [],
};
