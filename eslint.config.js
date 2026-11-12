import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.data/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/*.generated.ts',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Extension-point interfaces start empty and are filled by declaration merging.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A browser closes a <p> at a <form>, so the page it builds differs from the server's and
      // React reports a hydration error. FormButton renders a form.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXElement[openingElement.name.name='p'] JSXElement[openingElement.name.name=/^(form|FormButton)$/]",
          message:
            'A form can’t be inside a <p>: use <div className="para">, which is styled as one.',
        },
      ],
    },
  },
  {
    // The site, and @otwdesign/next, which holds the CMS's Next.js routes and components.
    files: ['apps/web/**/*.{ts,tsx}', 'packages/next/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: 'apps/web/' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
)
