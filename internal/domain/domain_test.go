package domain_test

import (
	"fmt"
	"testing"

	"github.com/timeStarry/frameMark/internal/domain"
)

func boolPtr(b bool) *bool { return &b }

// TestCollectionGrid covers status x visibility x distribute x viewer
// (owner "u1", other "u2", anonymous "") with explicit expectations.
func TestCollectionGrid(t *testing.T) {
	cases := []struct {
		status, visibility string
		distribute         bool
		viewer             string
		read, square, cdn  bool
	}{
		{"draft", "private", true, "u1", true, false, false},
		{"draft", "private", true, "u2", false, false, false},
		{"draft", "private", true, "", false, false, false},
		{"draft", "private", false, "u1", true, false, false},
		{"draft", "private", false, "u2", false, false, false},
		{"draft", "private", false, "", false, false, false},
		{"draft", "unlisted", true, "u1", true, false, false},
		{"draft", "unlisted", true, "u2", false, false, false},
		{"draft", "unlisted", true, "", false, false, false},
		{"draft", "unlisted", false, "u1", true, false, false},
		{"draft", "unlisted", false, "u2", false, false, false},
		{"draft", "unlisted", false, "", false, false, false},
		{"draft", "public", true, "u1", true, false, false},
		{"draft", "public", true, "u2", false, false, false},
		{"draft", "public", true, "", false, false, false},
		{"draft", "public", false, "u1", true, false, false},
		{"draft", "public", false, "u2", false, false, false},
		{"draft", "public", false, "", false, false, false},
		{"published", "private", true, "u1", true, false, false},
		{"published", "private", true, "u2", false, false, false},
		{"published", "private", true, "", false, false, false},
		{"published", "private", false, "u1", true, false, false},
		{"published", "private", false, "u2", false, false, false},
		{"published", "private", false, "", false, false, false},
		{"published", "unlisted", true, "u1", true, false, false},
		{"published", "unlisted", true, "u2", true, false, false},
		{"published", "unlisted", true, "", true, false, false},
		{"published", "unlisted", false, "u1", true, false, false},
		{"published", "unlisted", false, "u2", true, false, false},
		{"published", "unlisted", false, "", true, false, false},
		{"published", "public", true, "u1", true, true, true},
		{"published", "public", true, "u2", true, true, true},
		{"published", "public", true, "", true, true, true},
		{"published", "public", false, "u1", true, false, true},
		{"published", "public", false, "u2", true, false, true},
		{"published", "public", false, "", true, false, true},
	}
	if len(cases) != 36 {
		t.Fatalf("grid must have 36 rows, got %d", len(cases))
	}
	for _, tc := range cases {
		name := fmt.Sprintf("%s/%s/distribute=%v/viewer=%q", tc.status, tc.visibility, tc.distribute, tc.viewer)
		t.Run(name, func(t *testing.T) {
			c := domain.Collection{OwnerID: "u1", Status: tc.status, Visibility: tc.visibility, Distribute: tc.distribute}
			if got := domain.CanReadCollection(c, tc.viewer); got != tc.read {
				t.Errorf("CanReadCollection = %v, want %v", got, tc.read)
			}
			if got := domain.CollectionInSquare(c); got != tc.square {
				t.Errorf("CollectionInSquare = %v, want %v", got, tc.square)
			}
			if got := domain.UsesCDN(c, "https://cdn.example.com"); got != tc.cdn {
				t.Errorf("UsesCDN = %v, want %v", got, tc.cdn)
			}
			if domain.UsesCDN(c, "") {
				t.Errorf("UsesCDN with empty cdnBase must be false")
			}
		})
	}
}

func TestAnonymousNeverOwner(t *testing.T) {
	c := domain.Collection{OwnerID: "", Status: "draft", Visibility: "private"}
	if domain.CanReadCollection(c, "") {
		t.Fatal("anonymous viewer must not match empty OwnerID")
	}
	p := domain.Photo{OwnerID: ""}
	if domain.CanDownloadOriginal(p, c, "") {
		t.Fatal("anonymous viewer must not be photo owner")
	}
}

func TestEffectivePublicFields(t *testing.T) {
	photo := domain.Photo{PublicFields: []string{"camera", "iso"}, HistogramPublic: true}
	cases := []struct {
		name     string
		photo    domain.Photo
		override *domain.PhotoOverride
		want     map[string]bool
	}{
		{"nil override inherits snapshot", photo, nil,
			map[string]bool{"camera": true, "iso": true, "histogram": true}},
		{"nil fields inherits, histogram overridden", photo,
			&domain.PhotoOverride{HistogramPublic: boolPtr(false)},
			map[string]bool{"camera": true, "iso": true, "histogram": false}},
		{"replace fields, nil histogram inherits", photo,
			&domain.PhotoOverride{PublicFields: []string{"lens"}},
			map[string]bool{"lens": true, "histogram": true}},
		{"empty slice hides all", photo,
			&domain.PhotoOverride{PublicFields: []string{}},
			map[string]bool{"histogram": true}},
		{"histogram enabled by override", domain.Photo{PublicFields: []string{"camera"}},
			&domain.PhotoOverride{PublicFields: []string{"camera"}, HistogramPublic: boolPtr(true)},
			map[string]bool{"camera": true, "histogram": true}},
		{"unknown fields filtered", domain.Photo{PublicFields: []string{"camera", "gps", "histogram", ""}},
			nil, map[string]bool{"camera": true, "histogram": false}},
		{"all keys", domain.Photo{PublicFields: domain.PublicFieldKeys},
			&domain.PhotoOverride{PublicFields: nil},
			map[string]bool{"camera": true, "lens": true, "focal_length": true, "aperture": true,
				"shutter": true, "iso": true, "exposure_bias": true, "taken_date": true, "histogram": false}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := domain.EffectivePublicFields(tc.photo, tc.override)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for k, v := range tc.want {
				if gv, ok := got[k]; !ok || gv != v {
					t.Fatalf("key %q: got %v (present=%v), want %v; full %v", k, gv, ok, v, got)
				}
			}
		})
	}
}

func TestCanDownloadOriginal(t *testing.T) {
	cases := []struct {
		name   string
		photo  domain.Photo
		coll   domain.Collection
		viewer string
		want   bool
	}{
		{"photo owner on private draft", domain.Photo{OwnerID: "u1"},
			domain.Collection{OwnerID: "u1", Status: "draft", Visibility: "private"}, "u1", true},
		{"unlisted, not allowed", domain.Photo{OwnerID: "u1", AllowOriginal: true},
			domain.Collection{OwnerID: "u1", Status: "published", Visibility: "unlisted"}, "u2", false},
		{"unlisted, allowed by collection", domain.Photo{OwnerID: "u1"},
			domain.Collection{OwnerID: "u1", Status: "published", Visibility: "unlisted", AllowOriginal: true}, "u2", true},
		{"public, allowed, anonymous", domain.Photo{OwnerID: "u1"},
			domain.Collection{OwnerID: "u1", Status: "published", Visibility: "public", AllowOriginal: true}, "", true},
		{"private, allowed, other", domain.Photo{OwnerID: "u1"},
			domain.Collection{OwnerID: "u1", Status: "published", Visibility: "private", AllowOriginal: true}, "u2", false},
		{"draft public, allowed, other", domain.Photo{OwnerID: "u1"},
			domain.Collection{OwnerID: "u1", Status: "draft", Visibility: "public", AllowOriginal: true}, "u2", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := domain.CanDownloadOriginal(tc.photo, tc.coll, tc.viewer); got != tc.want {
				t.Errorf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestCanReadAlbumMember(t *testing.T) {
	pubMember := domain.Collection{OwnerID: "u1", Status: "published", Visibility: "public"}
	privMember := domain.Collection{OwnerID: "u1", Status: "published", Visibility: "private"}
	draftMember := domain.Collection{OwnerID: "u1", Status: "draft", Visibility: "public"}
	cases := []struct {
		name   string
		album  string
		member domain.Collection
		viewer string
		want   bool
	}{
		{"public album, public member, other", "public", pubMember, "u2", true},
		{"unlisted album, public member, anon", "unlisted", pubMember, "", true},
		{"public album, private member, other", "public", privMember, "u2", false},
		{"public album, draft member, anon", "public", draftMember, "", false},
		{"private album, public member, other", "private", pubMember, "u2", false},
		{"private album, private member, owner", "private", privMember, "u1", true},
		{"private album, draft member, owner", "private", draftMember, "u1", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := domain.Album{OwnerID: "u1", Visibility: tc.album}
			if got := domain.CanReadAlbumMember(a, tc.member, tc.viewer); got != tc.want {
				t.Errorf("got %v want %v", got, tc.want)
			}
		})
	}
	if domain.CanReadAlbumMember(domain.Album{Visibility: "private"}, domain.Collection{Status: "draft", Visibility: "private"}, "") {
		t.Error("anonymous must not own album or member with empty OwnerID")
	}
}

func TestValidators(t *testing.T) {
	for _, k := range []string{"camera", "lens", "focal_length", "aperture", "shutter", "iso", "exposure_bias", "taken_date"} {
		if !domain.ValidPublicField(k) {
			t.Errorf("ValidPublicField(%q) = false", k)
		}
	}
	if len(domain.PublicFieldKeys) != 8 {
		t.Errorf("PublicFieldKeys len = %d", len(domain.PublicFieldKeys))
	}
	for _, k := range []string{"", "histogram", "gps", "Camera", "latitude"} {
		if domain.ValidPublicField(k) {
			t.Errorf("ValidPublicField(%q) = true", k)
		}
	}
	for _, l := range []string{"by", "by-sa", "by-nd", "by-nc", "by-nc-sa", "by-nc-nd"} {
		if !domain.ValidLicense(l) {
			t.Errorf("ValidLicense(%q) = false", l)
		}
	}
	for _, l := range []string{"", "cc0", "BY", "by-sa-nc", "all-rights-reserved"} {
		if domain.ValidLicense(l) {
			t.Errorf("ValidLicense(%q) = true", l)
		}
	}
	if !domain.ValidAIDeclaration("no-generative-ai") {
		t.Error("ValidAIDeclaration(no-generative-ai) = false")
	}
	for _, a := range []string{"", "no-ai", "No-Generative-AI"} {
		if domain.ValidAIDeclaration(a) {
			t.Errorf("ValidAIDeclaration(%q) = true", a)
		}
	}
}
