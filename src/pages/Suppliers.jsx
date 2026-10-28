import CrudPage from '../components/CrudPage'
import { useT } from '../lib/i18n'

export default function Suppliers() {
  const t = useT()
  return (
    <CrudPage table="suppliers" title={t('nav_suppliers')} order="name" searchKeys={['name', 'contact']}
      defaults={{ active: true }}
      columns={[
        { key: 'name', label: t('name') },
        { key: 'contact', label: t('contact') },
        { key: 'phone', label: t('phone') },
        { key: 'email', label: t('email') },
      ]}
      fields={[
        { key: 'name', label: t('name'), required: true, span: 2 },
        { key: 'contact', label: t('contact') },
        { key: 'phone', label: t('phone') },
        { key: 'email', label: t('email') },
        { key: 'address', label: t('address') },
        { key: 'notes', label: t('notes'), type: 'textarea', span: 2 },
        { key: 'active', label: t('active'), type: 'bool' },
      ]} />
  )
}
