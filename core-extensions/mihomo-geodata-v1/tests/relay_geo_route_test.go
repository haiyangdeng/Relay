package main

import (
	"bytes"
	"context"
	http "github.com/metacubex/http"
	"io"
	"net"
	"strings"
	"testing"
)

func TestLocalGeoStrictFlatJSON(t *testing.T) {
	cases := []string{`{"version":1,"action":"state","act\u0069on":"state"}`, `{"version":1,"action":[]}`, `{"version":1,"nested":{}}`, `{"version":1}null`, strings.Repeat(" ", 4097), string([]byte{'{', '"', 'x', '"', ':', '"', 255, '"', '}'})}
	for _, body := range cases {
		r := &http.Request{Body: io.NopCloser(bytes.NewBufferString(body))}
		if _, e := relayGeoJSON(r); e == nil {
			t.Fatalf("unsafe JSON accepted %q", body)
		}
	}
	r := &http.Request{Body: io.NopCloser(bytes.NewBufferString(`{"version":1,"action":"state"}`))}
	if _, e := relayGeoJSON(r); e != nil {
		t.Fatal(e)
	}
}

type geoResponse struct {
	header http.Header
	code   int
	body   bytes.Buffer
}

func (r *geoResponse) Header() http.Header {
	if r.header == nil {
		r.header = make(http.Header)
	}
	return r.header
}
func (r *geoResponse) WriteHeader(code int) { r.code = code }
func (r *geoResponse) Write(body []byte) (int, error) {
	if r.code == 0 {
		r.code = 200
	}
	return r.body.Write(body)
}
func TestLocalGeoRealLocalAddrGate(t *testing.T) {
	for _, addr := range []net.Addr{nil, &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1}} {
		r := &http.Request{Method: "POST", Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"version":1,"action":"state"}`))}
		r.Header.Set("X-Local-Address", "unix")
		if addr != nil {
			r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, addr))
		}
		w := &geoResponse{}
		relayGeoHTTP(w, r)
		if w.code != 404 {
			t.Fatal("header/TCP spoof accepted", w.code)
		}
	}
}
