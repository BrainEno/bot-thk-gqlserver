import { FlatCompat } from '@eslint/eslintrc'

const compat = new FlatCompat({
    baseDirectory: import.meta.dirname,
})

export default [
    {
        ignores: ['build/**', 'coverage/**', 'node_modules/**'],
    },
    ...compat.config({
        root: true,
        env: { node: true },
        parser: '@typescript-eslint/parser',
        plugins: ['@typescript-eslint'],
        extends: ['plugin:@typescript-eslint/recommended', 'prettier'],
        rules: {
            'no-console': 'off',
            'prettier/prettier': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-unused-expressions': 'off',
            'no-unused-expressions': 'off',
        },
    }),
]
