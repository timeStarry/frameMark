package seed

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Manifest identity: only this exact seed and owner are accepted.
const (
	manifestVersion = 1
	seedName        = "markr-demo-v1"
	ownerName       = "markr-demo"

	minPhotos, maxPhotos           = 8, 12
	minCollections, maxCollections = 2, 3

	maxTextRunes  = 2000 // photo text, collection text, source fields
	maxTitleRunes = 120  // photo and collection titles (api maxTitleRunes)
	maxNameRunes  = 60   // profile name (api maxNameRunes)
	maxBioRunes   = 500  // profile bio (api maxBioRunes)
	maxSlugBytes  = 64
)

type manifest struct {
	Version     int          `json:"version"`
	Seed        string       `json:"seed"`
	Owner       string       `json:"owner"`
	Profile     profile      `json:"profile"`
	Photos      []photo      `json:"photos"`
	Collections []collection `json:"collections"`
}

type profile struct {
	Name    string   `json:"name"`
	Bio     string   `json:"bio"`
	Accent  string   `json:"accent"`
	Layout  string   `json:"layout"`
	Modules []string `json:"modules"`
	Cover   string   `json:"cover"`
}

type photo struct {
	ID           string `json:"id"`
	File         string `json:"file"`
	SHA256       string `json:"sha256"`
	Title        string `json:"title"`
	Text         string `json:"text"`
	Collection   string `json:"collection"`
	FeaturedRank *int   `json:"featuredRank"`
	// Source is kept byte for byte as written in the manifest file; it is
	// stored verbatim in attributions.source.
	Source json.RawMessage `json:"source"`
}

type source struct {
	Title       *string `json:"title"`
	Author      *string `json:"author"`
	SourcePage  *string `json:"sourcePage"`
	DownloadURL *string `json:"downloadURL"`
	LicenseName *string `json:"licenseName"`
	LicenseURL  *string `json:"licenseURL"`
	Changes     *string `json:"changes"`
}

type collection struct {
	ID     string   `json:"id"`
	Title  string   `json:"title"`
	Text   string   `json:"text"`
	Photos []string `json:"photos"`
}

var (
	slugRe     = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	fileRe     = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9._-]*\.(?:jpe?g|png|webp)$`)
	sha256Re   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	accentRe   = regexp.MustCompile(`(?i)^#[0-9a-f]{6}$`)
	ccByRe     = regexp.MustCompile(`(?i)^CC BY (1\.0|2\.0|2\.5|3\.0|4\.0)$`)
	ccZeroRe   = regexp.MustCompile(`(?i)^CC0(?: 1\.0(?: Universal)?)?$`)
	pdNameRe   = regexp.MustCompile(`(?i)^Public domain$`)
	ccZeroPath = regexp.MustCompile(`^/publicdomain/zero/1\.0/?$`)
	pdMarkPath = regexp.MustCompile(`^/publicdomain/mark/1\.0/?$`)
)

// ValidateManifest checks a manifest's schema and content rules (the rules
// of scripts/seed-demo.mjs) without touching any image file. Every failure
// wraps ErrInvalid.
func ValidateManifest(b []byte) error {
	_, err := parseManifest(b)
	return err
}

func parseManifest(b []byte) (*manifest, error) {
	var m manifest
	dec := json.NewDecoder(bytes.NewReader(b))
	if err := dec.Decode(&m); err != nil {
		return nil, invalid("manifest is not valid JSON: %v", err)
	}
	if dec.More() {
		return nil, invalid("manifest has trailing data")
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// text requires a non-blank string of at most limit runes.
func text(v, label string, limit int) error {
	if strings.TrimSpace(v) == "" || !utf8.ValidString(v) || utf8.RuneCountInString(v) > limit {
		return invalid("invalid %s", label)
	}
	return nil
}

func slug(v, label string) error {
	if len(v) > maxSlugBytes || !slugRe.MatchString(v) {
		return invalid("invalid %s %q", label, v)
	}
	return nil
}

// httpsURL parses an https URL on one of hosts, with no userinfo or port.
func httpsURL(v *string, hosts []string, label string) (*url.URL, error) {
	if v == nil {
		return nil, invalid("missing %s", label)
	}
	u, err := url.Parse(*v)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Opaque != "" {
		return nil, invalid("invalid %s", label)
	}
	for _, h := range hosts {
		if u.Host == h {
			return u, nil
		}
	}
	return nil, invalid("invalid %s host", label)
}

func (m *manifest) validate() error {
	if m.Version != manifestVersion || m.Seed != seedName || m.Owner != ownerName {
		return invalid("expected version 1 %s manifest for %s", seedName, ownerName)
	}
	if n := len(m.Photos); n < minPhotos || n > maxPhotos {
		return invalid("demo must contain %d–%d photos, got %d", minPhotos, maxPhotos, n)
	}
	if n := len(m.Collections); n < minCollections || n > maxCollections {
		return invalid("demo must contain %d–%d collections, got %d", minCollections, maxCollections, n)
	}

	p := m.Profile
	if !strings.Contains(p.Name, "Markr Demo") || !strings.Contains(p.Name, "演示") {
		return invalid("profile must clearly name Markr Demo and 演示")
	}
	if err := text(p.Name, "profile name", maxNameRunes); err != nil {
		return err
	}
	if err := text(p.Bio, "profile bio", maxBioRunes); err != nil {
		return err
	}
	if !accentRe.MatchString(p.Accent) || (p.Layout != "grid" && p.Layout != "column") {
		return invalid("invalid profile appearance")
	}
	if len(p.Modules) != 2 || !contains(p.Modules, "works") || !contains(p.Modules, "collections") {
		return invalid("invalid profile modules")
	}

	photoIDs := map[string]*photo{}
	files, shas, pages := map[string]bool{}, map[string]bool{}, map[string]bool{}
	featured := 0
	for i := range m.Photos {
		ph := &m.Photos[i]
		if err := slug(ph.ID, "photo id"); err != nil {
			return err
		}
		if photoIDs[ph.ID] != nil {
			return invalid("duplicate photo id %q", ph.ID)
		}
		photoIDs[ph.ID] = ph
		// A plain basename: the regexp admits no separator, and ".." cannot
		// match it but is refused explicitly as well.
		if !fileRe.MatchString(ph.File) || strings.Contains(ph.File, "..") || strings.ContainsAny(ph.File, `/\`) {
			return invalid("invalid photo filename %q", ph.File)
		}
		if files[ph.File] {
			return invalid("duplicate photo filename %q", ph.File)
		}
		files[ph.File] = true
		if !sha256Re.MatchString(ph.SHA256) {
			return invalid("invalid sha256 for %s", ph.ID)
		}
		// photos has UNIQUE(owner_id, original_sha256).
		if shas[ph.SHA256] {
			return invalid("duplicate sha256 for %s", ph.ID)
		}
		shas[ph.SHA256] = true
		if err := text(ph.Title, "photo title", maxTitleRunes); err != nil {
			return err
		}
		if err := text(ph.Text, "photo text", maxTextRunes); err != nil {
			return err
		}
		if err := slug(ph.Collection, "photo collection"); err != nil {
			return err
		}
		if ph.FeaturedRank != nil {
			if *ph.FeaturedRank != 1 {
				return invalid("only featuredRank 1 is supported")
			}
			featured++
		}
		if err := validateSource(ph, pages); err != nil {
			return err
		}
	}
	if featured != 1 {
		return invalid("exactly one featured photo is required, got %d", featured)
	}
	if photoIDs[p.Cover] == nil {
		return invalid("profile cover must reference a demo photo")
	}

	collIDs, member := map[string]bool{}, map[string]bool{}
	for _, c := range m.Collections {
		if err := slug(c.ID, "collection id"); err != nil {
			return err
		}
		if err := text(c.Title, "collection title", maxTitleRunes); err != nil {
			return err
		}
		if err := text(c.Text, "collection text", maxTextRunes); err != nil {
			return err
		}
		if collIDs[c.ID] {
			return invalid("duplicate collection id %q", c.ID)
		}
		collIDs[c.ID] = true
		if len(c.Photos) == 0 {
			return invalid("collection %s has no photos", c.ID)
		}
		for _, id := range c.Photos {
			ph := photoIDs[id]
			if ph == nil || member[id] {
				return invalid("invalid or repeated collection photo %q", id)
			}
			member[id] = true
			if ph.Collection != c.ID {
				return invalid("photo %s collection mismatch", id)
			}
		}
	}
	for _, ph := range m.Photos {
		if !collIDs[ph.Collection] {
			return invalid("photo %s names unknown collection %q", ph.ID, ph.Collection)
		}
	}
	if len(member) != len(photoIDs) {
		return invalid("every photo must belong to exactly one collection")
	}
	return nil
}

func validateSource(ph *photo, pages map[string]bool) error {
	if len(ph.Source) == 0 || ph.Source[0] != '{' {
		return invalid("missing source for %s", ph.ID)
	}
	var s source
	if err := json.Unmarshal(ph.Source, &s); err != nil {
		return invalid("invalid source for %s: %v", ph.ID, err)
	}
	for _, f := range []struct {
		v     *string
		label string
	}{{s.Title, "title"}, {s.Author, "author"}, {s.LicenseName, "licenseName"}, {s.Changes, "changes"}} {
		if f.v == nil {
			return invalid("missing source %s for %s", f.label, ph.ID)
		}
		if err := text(*f.v, "source "+f.label, maxTextRunes); err != nil {
			return err
		}
	}
	page, err := httpsURL(s.SourcePage, []string{"commons.wikimedia.org"}, "source page")
	if err != nil {
		return err
	}
	if !strings.HasPrefix(page.Path, "/wiki/File:") || pages[*s.SourcePage] {
		return invalid("source must be a distinct Wikimedia Commons file page")
	}
	pages[*s.SourcePage] = true
	if _, err := httpsURL(s.DownloadURL, []string{"upload.wikimedia.org", "thumb.wikimedia.org"}, "download URL"); err != nil {
		return err
	}
	lic, err := httpsURL(s.LicenseURL, []string{"creativecommons.org", "commons.wikimedia.org"}, "license URL")
	if err != nil {
		return err
	}
	name := strings.TrimSpace(*s.LicenseName)
	cc := lic.Host == "creativecommons.org"
	var ok bool
	switch {
	case ccZeroRe.MatchString(name):
		ok = cc && ccZeroPath.MatchString(lic.Path)
	case ccByRe.MatchString(name):
		ok = cc && strings.HasPrefix(lic.Path, "/licenses/by/"+ccByRe.FindStringSubmatch(name)[1]+"/")
	case pdNameRe.MatchString(name):
		ok = (cc && pdMarkPath.MatchString(lic.Path)) || (lic.Host == "commons.wikimedia.org" && strings.HasPrefix(lic.Path, "/wiki/"))
	}
	if !ok {
		return invalid("license for %s must be a matching CC0, Public domain or CC BY license", ph.ID)
	}
	return nil
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
