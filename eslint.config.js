// @ts-check
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  // 忽略目录
  { ignores: ['dist/**', 'node_modules/**', 'server/node_modules/**', 'src/sw.ts'] },

  // 前端：TypeScript + React Hooks
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      ...tseslint.configs.recommended,
    ],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // ---- React Hooks（防 bug，最高优先级）----
      'react-hooks/rules-of-hooks': 'error',           // hooks 调用位置违规是确定性 bug
      'react-hooks/exhaustive-deps': 'warn',            // 遗漏依赖是潜在 bug（warn 允许合理的注释豁免）

      // ---- TypeScript（防 bug）----
      '@typescript-eslint/no-explicit-any': 'warn',     // 我们已修了几处，继续收敛
      '@typescript-eslint/no-unused-vars': ['error', {
        varsIgnorePattern: '^_',                         // _开头变量视为有意忽略
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-non-null-assertion': 'warn', // ! 断言需留意

      // ---- 关掉几个 TypeScript recommended 中过于严格的规则，与项目现状匹配 ----
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-wrapper-object-types': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // 后端（Bun + Hono）：仅 TypeScript 规则
  {
    files: ['server/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', {
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
)
