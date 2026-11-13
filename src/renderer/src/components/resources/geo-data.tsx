import { Button } from '@heroui/react'
import { toast } from '@renderer/components/base/toast'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { mihomoUpgradeGeo } from '@renderer/utils/ipc'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GeoDataView, type GeoURLKey, type GeoURLs } from './geo-data-view'

const GeoData: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const {
    'geox-url': geoxUrl = {
      geoip: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip-lite.dat',
      geosite: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
      mmdb: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb',
      asn: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb'
    },
    'geodata-mode': geoMode = false,
    'geo-auto-update': geoAutoUpdate = false,
    'geo-update-interval': geoUpdateInterval = 24
  } = controledMihomoConfig || {}
  const [geoipInput, setGeoIpInput] = useState(geoxUrl.geoip)
  const [geositeInput, setGeositeInput] = useState(geoxUrl.geosite)
  const [mmdbInput, setMmdbInput] = useState(geoxUrl.mmdb)
  const [asnInput, setAsnInput] = useState(geoxUrl.asn)
  const [updating, setUpdating] = useState(false)

  const inputs = { geoip: geoipInput, geosite: geositeInput, mmdb: mmdbInput, asn: asnInput }
  const urls: GeoURLs = {
    geoip: geoipInput ?? '',
    geosite: geositeInput ?? '',
    mmdb: mmdbInput ?? '',
    asn: asnInput ?? ''
  }
  const setters = {
    geoip: setGeoIpInput,
    geosite: setGeositeInput,
    mmdb: setMmdbInput,
    asn: setAsnInput
  }
  const actions = Object.fromEntries(
    (Object.keys(urls) as GeoURLKey[]).map((key) => [
      key,
      inputs[key] !== geoxUrl[key] ? (
        <Button
          key={key}
          size="sm"
          color="primary"
          className="mr-2"
          onPress={() => {
            void patchControledMihomoConfig({ 'geox-url': { ...geoxUrl, [key]: urls[key] } })
          }}
        >
          {t('common.confirm')}
        </Button>
      ) : null
    ])
  )
  return (
    <GeoDataView
      urls={urls}
      onURLChange={(key, value) => setters[key](value)}
      urlActions={actions}
      mode={geoMode ? 'dat' : 'db'}
      onModeChange={(value) => {
        void patchControledMihomoConfig({ 'geodata-mode': value === 'dat' })
      }}
      autoUpdate={geoAutoUpdate}
      onAutoChange={(value) => {
        void patchControledMihomoConfig({ 'geo-auto-update': value })
      }}
      intervalHours={(geoUpdateInterval ?? 24).toString()}
      onHoursChange={(value) => {
        const parsed = parseInt(value)
        if (!Number.isNaN(parsed))
          void patchControledMihomoConfig({ 'geo-update-interval': parsed })
      }}
      updating={updating}
      onUpdate={() => {
        void (async () => {
          setUpdating(true)
          try {
            await mihomoUpgradeGeo()
            new Notification(t('resources.geoData.updateSuccess'))
          } catch (e) {
            toast.error(String(e))
          } finally {
            setUpdating(false)
          }
        })()
      }}
    />
  )
}

export default GeoData
