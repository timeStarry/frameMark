// Package domain holds the pure permission and public-field rules (spec §4, §7).
// It performs no IO; the API layer must call these instead of reimplementing them.
//
// Viewer convention: an empty viewer string means anonymous. An anonymous
// viewer is never treated as an owner, even when OwnerID is also empty.
package domain

const (
	StatusDraft     = "draft"
	StatusPublished = "published"

	VisibilityPrivate  = "private"
	VisibilityUnlisted = "unlisted"
	VisibilityPublic   = "public"

	// HistogramKey is the extra key EffectivePublicFields reports alongside
	// the §4 public_fields keys.
	HistogramKey = "histogram"
)

// Collection is the permission-relevant subset of a collections row.
type Collection struct {
	ID            string
	OwnerID       string
	Status        string // draft | published
	Visibility    string // private | unlisted | public
	Distribute    bool
	AllowOriginal bool // collections.original_download
}

// Photo is the permission-relevant subset of a photos row. PublicFields,
// HistogramPublic and AllowOriginal are the upload-pref snapshot taken at ingest.
type Photo struct {
	ID              string
	OwnerID         string
	PublicFields    []string
	HistogramPublic bool
	AllowOriginal   bool
}

// PhotoOverride is a photo_overrides row. A nil field means "not overridden".
type PhotoOverride struct {
	PublicFields    []string
	HistogramPublic *bool
}

// Album is the permission-relevant subset of an albums row. Albums have no status.
type Album struct {
	ID         string
	OwnerID    string
	Visibility string // private | unlisted | public
}

// PublicFieldKeys lists the allowed public_fields keys (spec §4). Callers must not mutate it.
var PublicFieldKeys = []string{
	"camera", "lens", "focal_length", "aperture",
	"shutter", "iso", "exposure_bias", "taken_date",
}

var (
	publicFieldSet = toSet(PublicFieldKeys)
	licenseSet     = toSet([]string{"by", "by-sa", "by-nd", "by-nc", "by-nc-sa", "by-nc-nd"})
)

func toSet(keys []string) map[string]struct{} {
	s := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		s[k] = struct{}{}
	}
	return s
}

// ValidPublicField reports whether key is one of PublicFieldKeys.
func ValidPublicField(key string) bool {
	_, ok := publicFieldSet[key]
	return ok
}

// ValidLicense reports whether code is one of the 6 CC 4.0 codes.
func ValidLicense(code string) bool {
	_, ok := licenseSet[code]
	return ok
}

// ValidAIDeclaration reports whether code is an allowed AI declaration.
func ValidAIDeclaration(code string) bool {
	return code == "no-generative-ai"
}

func isOwner(ownerID, viewer string) bool {
	return viewer != "" && ownerID == viewer
}

func openVisibility(v string) bool {
	return v == VisibilityPublic || v == VisibilityUnlisted
}

// CanReadCollection: the owner can always read. Anyone else can read only a
// published collection whose visibility is public or unlisted.
func CanReadCollection(c Collection, viewer string) bool {
	if isOwner(c.OwnerID, viewer) {
		return true
	}
	return c.Status == StatusPublished && openVisibility(c.Visibility)
}

// CollectionInSquare: published, public and distribute.
func CollectionInSquare(c Collection) bool {
	return c.Status == StatusPublished && c.Visibility == VisibilityPublic && c.Distribute
}

// CanReadAlbumMember reports whether viewer may see member through album.
// An album never raises a member's visibility: both the album and the member
// must be readable on their own terms. An album is readable by its owner or
// when its visibility is public or unlisted.
func CanReadAlbumMember(a Album, member Collection, viewer string) bool {
	albumReadable := isOwner(a.OwnerID, viewer) || openVisibility(a.Visibility)
	return albumReadable && CanReadCollection(member, viewer)
}

// EffectivePublicFields returns the fields a photo publicly exposes in one
// collection's context: the photo snapshot, replaced by override fields that
// are non-nil. A non-nil empty override slice hides every field. Unknown keys
// are dropped. Only enabled field keys are present; HistogramKey is always present.
func EffectivePublicFields(p Photo, o *PhotoOverride) map[string]bool {
	src := p.PublicFields
	if o != nil && o.PublicFields != nil {
		src = o.PublicFields
	}
	fields := make(map[string]bool, len(src)+1)
	for _, f := range src {
		if ValidPublicField(f) {
			fields[f] = true
		}
	}
	fields[HistogramKey] = p.HistogramPublic
	if o != nil && o.HistogramPublic != nil {
		fields[HistogramKey] = *o.HistogramPublic
	}
	return fields
}

// CanDownloadOriginal: the photo owner always can. Anyone else needs the
// collection to be readable and to allow original download.
//
// p.AllowOriginal is deliberately ignored: per spec §7 the collection's
// original_download setting decides at read time, and the photo field is only
// an upload-pref snapshot.
func CanDownloadOriginal(p Photo, c Collection, viewer string) bool {
	if isOwner(p.OwnerID, viewer) {
		return true
	}
	return CanReadCollection(c, viewer) && c.AllowOriginal
}

// UsesCDN: fixed CDN URLs only for published public collections when a CDN is
// configured. Everything else, unlisted included, goes through the
// same-origin /m/ re-auth redirect.
func UsesCDN(c Collection, cdnBase string) bool {
	return cdnBase != "" && c.Status == StatusPublished && c.Visibility == VisibilityPublic
}
