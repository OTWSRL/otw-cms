import type { Brand } from '@otwdesign/core'

/** The CMS's mark on the sign-in screens, where WordPress shows its logo. A brand's logo replaces it. */
export function BrandMark({ brand }: { brand: Brand }) {
  // eslint-disable-next-line @next/next/no-img-element -- any size or format the brand supplies, unoptimized
  if (brand.logo) return <img src={brand.logo} alt="" width={84} height={84} />
  return (
    <svg viewBox="0 0 84 84" width="84" height="84" aria-hidden="true" focusable="false">
      <circle cx="42" cy="42" r="38" fill="none" stroke="currentColor" strokeWidth="5" />
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="23" cy="42" r="8.5" />
        <path d="M35 33.5h15M42.5 33.5v17" />
        <path d="m53 33.5 3.5 17 4.5-12 4.5 12 3.5-17" />
      </g>
    </svg>
  )
}

/** The brand's name, linked to its site when it has one, as the admin footer links WordPress's. */
export function BrandName({ brand }: { brand: Brand }) {
  return brand.url ? <a href={brand.url}>{brand.name}</a> : <>{brand.name}</>
}
