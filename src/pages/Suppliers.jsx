import CrudPage from '../components/CrudPage'
import { useT } from '../lib/i18n'

export default function Suppliers() {
  const t = useT()
  return (
    <CrudPage table="suppliers" title={t('nav_suppliers')} order="name" searchKeys={['name', 'contact']}
      defaults={{ active: true, order_via: 'other' }}
      columns={[
        { key: 'name', label: t('name') },
        { key: 'contact', label: t('contact') },
        { key: 'phone', label: t('phone') },
        { key: 'email', label: t('email') },
        { key: 'order_via', label: t('orderVia'), render: r => r.order_via === 'slack' ? 'Slack' : r.order_via === 'email' ? t('orderViaEmail') : '–' },
      ]}
      fields={[
        { key: 'name', label: t('name'), required: true, span: 2 },
        { key: 'contact', label: t('contact') },
        { key: 'phone', label: t('phone') },
        { key: 'email', label: t('email') },
        { key: 'address', label: t('address') },
        { key: 'order_via', label: t('orderVia'), type: 'select', required: true,
          options: [['other', t('orderViaOther')], ['email', t('orderViaEmail')], ['slack', 'Slack']] },
        { key: 'slack_member', label: t('slackMember'), hint: t('slackMemberHint') },
        { key: 'notes', label: t('notes'), type: 'textarea', span: 2 },
        { key: 'active', label: t('active'), type: 'bool' },
      ]} />
  )
}
