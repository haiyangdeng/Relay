//go:build darwin && relay_local_geodata

package geodata

import (
	"fmt"
	"github.com/metacubex/mihomo/component/geodata/router"
	"github.com/metacubex/mihomo/component/mmdb"
	"google.golang.org/protobuf/proto"
)

// Whole DAT structure validation reuses the fixed generated router/protobuf
// types. No CN/RELAY marker is forced here; the existing rule constructor then
// checks its actual selected tag/attributes with the standard matcher path.
// Missing/invalid controlled assets are errors, never Remove/download/reset.
func relayControlledInitSite() error {
	initGeoSiteMutex.Lock()
	defer initGeoSiteMutex.Unlock()
	if initGeoSite {
		return nil
	}
	data, err := mmdb.ReadControlledAsset("geosite-dat")
	if err != nil {
		return err
	}
	var list router.GeoSiteList
	if err = proto.Unmarshal(data, &list); err != nil {
		return err
	}
	if len(list.Entry) == 0 {
		return fmt.Errorf("empty controlled GeoSite")
	}
	initGeoSite = true
	return nil
}
func relayControlledInitIP() error {
	initGeoIPMutex.Lock()
	defer initGeoIPMutex.Unlock()
	if GeodataMode() {
		if initGeoIP == 1 {
			return nil
		}
		data, err := mmdb.ReadControlledAsset("geoip-dat")
		if err != nil {
			return err
		}
		var list router.GeoIPList
		if err = proto.Unmarshal(data, &list); err != nil {
			return err
		}
		if len(list.Entry) == 0 {
			return fmt.Errorf("empty controlled GeoIP")
		}
		initGeoIP = 1
		return nil
	}
	if initGeoIP == 2 {
		return nil
	}
	data, err := mmdb.ReadControlledAsset("country-mmdb")
	if err != nil {
		return err
	}
	next, err := mmdb.PrepareIP(data)
	if err != nil {
		return err
	}
	mmdb.PublishIP(next)
	initGeoIP = 2
	return nil
}
func relayControlledInitASN() error {
	initASNMutex.Lock()
	defer initASNMutex.Unlock()
	if initASN {
		return nil
	}
	data, err := mmdb.ReadControlledAsset("asn-mmdb")
	if err != nil {
		return err
	}
	next, err := mmdb.PrepareASN(data)
	if err != nil {
		return err
	}
	mmdb.PublishASN(next)
	initASN = true
	return nil
}
