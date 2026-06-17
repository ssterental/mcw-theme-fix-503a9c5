/* ==============================================================
   MCW Photo Builder — Main Application
   4-step wizard: Upload → Crop & Organize → Customize → Add to Cart
   Vanilla JS, no frameworks — keeps bundle small
   ============================================================== */

(function () {
  'use strict';

  /* ── Constants ── */
  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
  const MAX_DIMENSION = 3000; // px longest edge for compression
  const JPEG_QUALITY = 0.85;
  const MAX_CONCURRENT_UPLOADS = 4;
  const SESSION_EXPIRY_DAYS = 7;
  const UNDO_TIMEOUT = 5000; // ms
  const CART_PAYLOAD_WARN = 6000; // bytes
  const CART_PAYLOAD_MAX = 7000; // bytes

  const ACCEPTED_TYPES = [
    'image/jpeg', 'image/png', 'image/webp',
    'image/heic', 'image/heif'
  ];

  /* ── Helpers ── */
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function (kv) {
      if (kv[0] === 'className') node.className = kv[1];
      else if (kv[0] === 'innerHTML') node.innerHTML = kv[1];
      else if (kv[0].startsWith('on')) node.addEventListener(kv[0].slice(2).toLowerCase(), kv[1]);
      else node.setAttribute(kv[0], kv[1]);
    });
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else if (c) node.appendChild(c);
      });
    }
    return node;
  }

  function getUrlParams() {
    var p = new URLSearchParams(window.location.search);
    return {
      product: p.get('product') || '',
      variant: p.get('variant') || '',
      pages: p.get('pages') || '',
      min: parseInt(p.get('min'), 10) || 0,
      max: parseInt(p.get('max'), 10) || 0,
      coverVariant: p.get('cover_variant') || '',
      step: parseInt(p.get('step'), 10) || 1,
      edit: p.get('edit') === 'true',
      lineKey: p.get('line_key') || ''
    };
  }

  function formatMoney(cents) {
    var fmt = window.MCW_BUILDER_CONFIG.moneyFormat || '${{amount}}';
    var amount = (cents / 100).toFixed(2);
    return fmt.replace(/\{\{amount\}\}/g, amount)
              .replace(/\{\{amount_no_decimals\}\}/g, Math.round(cents / 100))
              .replace(/\{\{amount_with_comma_separator\}\}/g, amount.replace('.', ','));
  }

  function generateSessionId() {
    var arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function generateBundleId() {
    return 'mcwb_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
  }

  /* ── Session Storage (localStorage) ── */
  var SessionStore = {
    _prefix: 'mcw_builder_',

    _key: function (handle) {
      // Find existing session for this product handle
      var keys = Object.keys(localStorage).filter(function (k) {
        return k.startsWith(SessionStore._prefix + handle + '_');
      });
      return keys.length > 0 ? keys[0] : null;
    },

    _newKey: function (handle) {
      return SessionStore._prefix + handle + '_' + Date.now() + '_' + generateSessionId();
    },

    load: function (handle) {
      var key = SessionStore._key(handle);
      if (!key) return null;
      try {
        var data = JSON.parse(localStorage.getItem(key));
        // Check expiry
        if (data && data.createdAt) {
          var age = Date.now() - data.createdAt;
          if (age > SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000) {
            localStorage.removeItem(key);
            return null;
          }
        }
        data._storageKey = key;
        return data;
      } catch (e) {
        localStorage.removeItem(key);
        return null;
      }
    },

    save: function (handle, state) {
      var key = state._storageKey || SessionStore._key(handle) || SessionStore._newKey(handle);
      var data = Object.assign({}, state);
      delete data._storageKey;
      data.updatedAt = Date.now();
      try {
        localStorage.setItem(key, JSON.stringify(data));
        state._storageKey = key;
      } catch (e) {
        console.warn('MCW Builder: localStorage save failed', e);
      }
    },

    clear: function (handle) {
      var key = SessionStore._key(handle);
      if (key) localStorage.removeItem(key);
    },

    hasAnySession: function () {
      return Object.keys(localStorage).some(function (k) {
        return k.startsWith(SessionStore._prefix);
      });
    },

    cleanExpired: function () {
      var now = Date.now();
      var maxAge = SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
      Object.keys(localStorage).forEach(function (k) {
        if (!k.startsWith(SessionStore._prefix)) return;
        try {
          var data = JSON.parse(localStorage.getItem(k));
          if (data && data.createdAt && (now - data.createdAt > maxAge)) {
            localStorage.removeItem(k);
          }
        } catch (e) {
          localStorage.removeItem(k);
        }
      });
    }
  };

  /* ── Photo Uploader (S3 pre-signed URLs) ── */
  function PhotoUploader(config) {
    this.endpoint = config.uploadEndpoint;
    this.queue = [];
    this.active = 0;
  }

  PhotoUploader.prototype.getPresignedUrl = function (sessionId, contentType) {
    return fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, contentType: contentType || 'image/jpeg' })
    }).then(function (r) {
      if (!r.ok) throw new Error('Pre-signed URL request failed: ' + r.status);
      return r.json();
    });
  };

  PhotoUploader.prototype.uploadToS3 = function (uploadUrl, blob, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl, true);
      xhr.setRequestHeader('Content-Type', 'image/jpeg');
      if (onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('S3 upload failed: ' + xhr.status));
      };
      xhr.onerror = function () { reject(new Error('S3 upload network error')); };
      xhr.send(blob);
    });
  };

  PhotoUploader.prototype.compressImage = function (file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        var w = img.width, h = img.height;
        if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
          var ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('Canvas compression failed'));
        }, 'image/jpeg', JPEG_QUALITY);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = function () {
        URL.revokeObjectURL(img.src);
        reject(new Error('Image load failed'));
      };
      img.src = URL.createObjectURL(file);
    });
  };

  PhotoUploader.prototype.convertHeic = function (file) {
    if (typeof heic2any === 'undefined') {
      return Promise.reject(new Error('HEIC converter not loaded'));
    }
    return heic2any({ blob: file, toType: 'image/jpeg', quality: JPEG_QUALITY })
      .then(function (result) {
        // heic2any may return array of blobs
        var blob = Array.isArray(result) ? result[0] : result;
        return new File([blob], file.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' });
      });
  };

  PhotoUploader.prototype.processAndUpload = function (file, sessionId, onProgress, onStatusChange) {
    var self = this;
    var isHeic = /\.(heic|heif)$/i.test(file.name) ||
                 file.type === 'image/heic' || file.type === 'image/heif';

    return new Promise(function (resolve, reject) {
      var pipeline = Promise.resolve(file);

      // Step 1: HEIC conversion if needed
      if (isHeic) {
        if (onStatusChange) onStatusChange('converting');
        pipeline = pipeline.then(function () {
          return self.convertHeic(file);
        });
      }

      // Step 2: Compress
      pipeline = pipeline.then(function (processedFile) {
        if (onStatusChange) onStatusChange('compressing');
        return self.compressImage(processedFile);
      });

      // Step 3: Get pre-signed URL and upload
      pipeline = pipeline.then(function (blob) {
        if (onStatusChange) onStatusChange('uploading');
        return self.getPresignedUrl(sessionId, 'image/jpeg').then(function (urlData) {
          return self.uploadToS3(urlData.uploadUrl, blob, onProgress).then(function () {
            return {
              publicUrl: urlData.publicUrl,
              key: urlData.key
            };
          });
        });
      });

      pipeline.then(resolve).catch(reject);
    });
  };

  /* ── Main Builder App ── */
  function MCWBuilder(rootEl) {
    this.root = rootEl;
    this.config = window.MCW_BUILDER_CONFIG || {};
    this.params = getUrlParams();
    this.uploader = new PhotoUploader(this.config);
    this.cropper = null; // Cropper.js instance

    // State
    this.state = {
      photos: [],        // [{id, url, thumbUrl, filename, status:'ready'|'uploading'|'error', order}]
      rejectedFiles: [], // [{id, name, thumbUrl, file}] — files turned away at the door because they'd push past maxPhotos
      variantId: null,
      productHandle: '',
      productTitle: '',
      variantTitle: '',
      minPhotos: 16,
      maxPhotos: 20,
      coverVariantId: null,
      coverPrice: 0,
      coverSelected: false,
      coverPhotoUrl: '',
      coverText: '',
      currentStep: 1,
      sessionId: generateSessionId(),
      createdAt: Date.now(),
      variants: [],      // all product variants for size switching
      bookPrice: 0,
      _storageKey: null,
      // Editing an existing cart line — set by hydrateFromCartLine()
      editingLineKey: null,       // book line key in /cart.js (used to remove/replace on save)
      editingCoverLineKey: null   // matching cover line key, if any
    };

    this._undoTimer = null;
    this._undoData = null;
    this._dragState = null;
    this._uploadQueue = [];
    this._activeUploads = 0;

    this.init();
  }

  MCWBuilder.prototype.init = function () {
    var self = this;

    // Clean up expired sessions on load
    SessionStore.cleanExpired();

    // Without window-level drag/drop guards, dropping a file anywhere outside
    // the upload zone navigates the tab to that file. Prevent default globally;
    // the upload zone's own drop handler still fires on valid drops.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (!e.target.closest || !e.target.closest('.mcw-upload-zone')) {
        e.preventDefault();
      }
    });

    // Show loading state
    this.root.innerHTML = '<div class="mcw-builder"><div class="mcw-loading"><div class="spinner"></div><p>Loading your builder...</p></div></div>';

    if (!this.params.product || !this.params.variant) {
      // Hard-fail only if there's no saved draft to resume. If one exists
      // (pencil icon, bookmarked URL, etc.), pick the most-recently-touched
      // session and reconstruct the missing params so the normal
      // Welcome-Back flow takes over.
      var resumed = this._resumeFromSavedSession();
      if (!resumed) {
        this.showError('Missing product information. Please start from the product page.');
        return;
      }
    }

    // Fetch product data from Shopify AJAX API
    this.fetchProductData().then(function (product) {
      self.applyProductData(product);

      // Edit-from-cart flow: hydrate state from the existing cart line and land
      // straight on Step 4. Skips Welcome Back because this is a deliberate
      // "edit this cart item" entry, not a resumed draft.
      if (self.params.edit && self.params.lineKey) {
        return self.hydrateFromCartLine(self.params.lineKey).then(function (ok) {
          if (!ok) {
            self.showError('Could not find that item in your cart. It may have been removed.');
            return;
          }
          self.render();
        });
      }

      // Check for existing session
      var saved = SessionStore.load(self.state.productHandle);
      if (saved && saved.photos && saved.photos.length > 0) {
        self.showWelcomeBackModal(saved);
      } else {
        self.render();
      }
    }).catch(function (err) {
      console.error('MCW Builder init error:', err);
      self.showError('Could not load product data. Please try again.');
    });

    // Handle browser back/forward
    window.addEventListener('popstate', function (e) {
      if (e.state && e.state.mcwStep) {
        var step = e.state.mcwStep;
        if (step < 1) {
          self.saveAndExit();
        } else {
          self.state.currentStep = step;
          self.renderStep();
        }
      }
    });
  };

  MCWBuilder.prototype.fetchProductData = function () {
    var handle = this.params.product;
    return fetch('/products/' + handle + '.js')
      .then(function (r) {
        if (!r.ok) throw new Error('Product fetch failed: ' + r.status);
        return r.json();
      });
  };

  // Used by init when URL params are missing. Scans localStorage for saved
  // drafts, picks the most-recently-updated one, and fills in `this.params`
  // so the normal product fetch + Welcome Back flow can run. Returns true on
  // success, false when there's nothing to resume.
  MCWBuilder.prototype._resumeFromSavedSession = function () {
    var prefix = SessionStore._prefix;
    var best = null;
    var bestHandle = null;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(prefix) !== 0) continue;
      var rest = k.slice(prefix.length);
      var sep = rest.indexOf('_');
      if (sep <= 0) continue;
      var handle = rest.slice(0, sep);
      try {
        var data = JSON.parse(localStorage.getItem(k));
        if (!data || !data.variantId) continue;
        var ts = data.updatedAt || data.createdAt || 0;
        if (!best || ts > (best.updatedAt || best.createdAt || 0)) {
          best = data;
          bestHandle = handle;
        }
      } catch (e) { /* skip malformed entries */ }
    }
    if (!best) return false;
    this.params.product = bestHandle;
    this.params.variant = String(best.variantId);
    return true;
  };

  // Hydrate builder state from an existing cart line. Called when the user
  // clicks "Edit Design" on a cart item (?edit=true&line_key=X). Reads the
  // book line's Uploaded Pictures + Choose Cover Photo + Your Personal Message
  // properties, finds the paired cover line via _mcw_bundle_id, and lands the
  // user on Step 4. Returns a Promise<bool>.
  MCWBuilder.prototype.hydrateFromCartLine = function (lineKey) {
    var self = this;
    return fetch('/cart.js', { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('Cart fetch failed: ' + r.status);
        return r.json();
      })
      .then(function (cart) {
        var bookLine = (cart.items || []).find(function (it) { return it.key === lineKey; });
        if (!bookLine) return false;

        var props = bookLine.properties || {};

        // Rebuild photos array from Uploaded Pictures 1..N, preserving order.
        var photoEntries = [];
        Object.keys(props).forEach(function (k) {
          var m = k.match(/^Uploaded Pictures (\d+)$/);
          if (m && props[k]) {
            photoEntries.push({ idx: parseInt(m[1], 10), url: props[k] });
          }
        });
        photoEntries.sort(function (a, b) { return a.idx - b.idx; });
        self.state.photos = photoEntries.map(function (e, i) {
          return {
            id: 'cart_' + i + '_' + Math.random().toString(36).substr(2, 6),
            url: e.url,
            thumbUrl: e.url,
            filename: '',
            status: 'ready',
            order: i
          };
        });

        // Rebuild cover state
        if (props['Choose Cover Photo']) {
          self.state.coverSelected = true;
          self.state.coverPhotoUrl = props['Choose Cover Photo'];
          self.state.coverText = props['Your Personal Message'] || '';
        }

        // Find the paired cover line so Save Changes can remove it.
        var bundleId = props['_mcw_bundle_id'];
        if (bundleId) {
          var coverLine = (cart.items || []).find(function (it) {
            return (it.properties || {})['_mcw_parent_bundle_id'] === bundleId;
          });
          if (coverLine) self.state.editingCoverLineKey = coverLine.key;
        }

        // Defensive: a customer's already-paid-for photos must never be flagged
        // "too many". If the rehydrated count exceeds the configured maxPhotos
        // (e.g. URL params missing for a 40-page book), bump max to fit.
        var existingCount = self.state.photos.length;
        if (existingCount > self.state.maxPhotos) {
          self.state.maxPhotos = existingCount;
        }

        // Mark as editing + land on Review
        self.state.editingLineKey = lineKey;
        self.state.currentStep = 4;
        return true;
      })
      .catch(function (err) {
        console.error('MCW Builder hydrate error:', err);
        return false;
      });
  };

  MCWBuilder.prototype.applyProductData = function (product) {
    this.state.productHandle = product.handle;
    this.state.productTitle = product.title;
    this.state.variants = product.variants.map(function (v) {
      return {
        id: v.id,
        title: v.title,
        price: v.price, // in cents
        available: v.available
      };
    });

    // Find selected variant
    var variantId = parseInt(this.params.variant, 10);
    var variant = product.variants.find(function (v) { return v.id === variantId; });
    if (!variant && product.variants.length > 0) variant = product.variants[0];

    this.state.variantId = variant.id;
    this.state.variantTitle = variant.title;
    this.state.bookPrice = variant.price;

    // Page count resolution order:
    //   1. URL param `pages` (set by builder-cta from variant metafield or product title)
    //   2. Regex on variant title
    //   3. Regex on product title
    //   4. Default 20
    var pageCount = parseInt(this.params.pages, 10);
    if (!pageCount) {
      var pageMatch = variant.title.match(/(\d+)/) || product.title.match(/(\d+)/);
      pageCount = pageMatch ? parseInt(pageMatch[1], 10) : 20;
    }

    // URL params carry metafield values set by builder-cta — trust them first
    if (this.params.min) this.state.minPhotos = this.params.min;
    if (this.params.max) this.state.maxPhotos = this.params.max;
    if (this.params.coverVariant) this.state.coverVariantId = parseInt(this.params.coverVariant, 10);

    // Secondary source: fetch via metafield endpoint (if set up)
    this.fetchMetafields(product);

    // Final fallback: derive from page count
    if (!this.state.minPhotos) {
      this.state.minPhotos = Math.max(1, pageCount - 4);
    }
    if (!this.state.maxPhotos) {
      this.state.maxPhotos = pageCount;
    }
    // Store pageCount on state so the display can show the book's actual page count
    // (e.g. "0 of 32 photos") separately from maxPhotos which may be larger (e.g. 34
    // with a +2 buffer). All validation/enforcement still uses maxPhotos.
    this.state.pageCount = pageCount;
  };

  MCWBuilder.prototype.fetchMetafields = function (product) {
    // Metafields are passed via the page if available, or read from product context
    // For now, check if they're in the product JSON response
    // Shopify's /products/{handle}.js doesn't include metafields, so we rely on
    // the Liquid-injected config or fetch from a metafield endpoint

    // Check Liquid-injected config first
    var cfg = this.config;
    if (cfg.minPhotos) this.state.minPhotos = parseInt(cfg.minPhotos, 10);
    if (cfg.maxPhotos) this.state.maxPhotos = parseInt(cfg.maxPhotos, 10);
    if (cfg.coverVariantId) {
      this.state.coverVariantId = parseInt(cfg.coverVariantId, 10);
    }
    if (cfg.coverPrice) {
      this.state.coverPrice = parseInt(cfg.coverPrice, 10);
    }

    // Attempt to fetch metafields via Storefront-compatible endpoint
    var self = this;
    var handle = product.handle;
    fetch('/products/' + handle + '?view=metafields', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        if (data.min_photos) self.state.minPhotos = parseInt(data.min_photos, 10);
        if (data.max_photos) self.state.maxPhotos = parseInt(data.max_photos, 10);
        if (data.cover_variant_id) self.state.coverVariantId = parseInt(data.cover_variant_id, 10);
        if (data.cover_price) self.state.coverPrice = parseInt(data.cover_price, 10);
        // Re-render threshold display if already visible
        self.updateThresholdDisplay();
      })
      .catch(function () { /* metafield endpoint not available — use Liquid defaults */ });
  };

  /* ── Welcome Back Modal ── */
  MCWBuilder.prototype.showWelcomeBackModal = function (savedState) {
    var self = this;
    var photoCount = savedState.photos.filter(function (p) { return p.status === 'ready'; }).length;

    this.root.innerHTML = '';
    var backdrop = el('div', { className: 'mcw-modal-backdrop' }, [
      el('div', { className: 'mcw-modal' }, [
        el('h2', { className: 'mcw-modal-title' }, 'Welcome back!'),
        el('p', { className: 'mcw-modal-text' },
          'You have ' + photoCount + ' photo' + (photoCount !== 1 ? 's' : '') + ' from a previous session. Would you like to continue where you left off?'
        ),
        el('div', { className: 'mcw-modal-actions' }, [
          el('button', {
            className: 'mcw-btn-primary',
            onClick: function () {
              self.restoreSession(savedState);
            }
          }, 'Continue Building'),
          el('button', {
            className: 'mcw-btn-secondary',
            onClick: function () {
              SessionStore.clear(self.state.productHandle);
              self.render();
            }
          }, 'Start Fresh')
        ])
      ])
    ]);
    this.root.appendChild(backdrop);
  };

  MCWBuilder.prototype.restoreSession = function (saved) {
    // Restore photos that completed upload (status === 'ready')
    // Blob URLs (createObjectURL) only live for the session that created them —
    // after reload they point to nothing and the <img> breaks. Discard any
    // `blob:` thumbUrl on restore and fall back to the permanent S3 URL.
    this.state.photos = (saved.photos || []).filter(function (p) {
      return p.status === 'ready' && p.url;
    }).map(function (p, i) {
      var thumb = p.thumbUrl;
      if (!thumb || /^blob:/i.test(thumb)) thumb = p.url;
      return { id: p.id || ('restored_' + i), url: p.url, thumbUrl: thumb, filename: p.filename || '', status: 'ready', order: i };
    });

    if (saved.variantId) this.state.variantId = saved.variantId;
    if (saved.coverSelected) this.state.coverSelected = saved.coverSelected;
    if (saved.coverPhotoUrl) this.state.coverPhotoUrl = saved.coverPhotoUrl;
    if (saved.coverText) this.state.coverText = saved.coverText;
    if (saved.sessionId) this.state.sessionId = saved.sessionId;
    if (saved.createdAt) this.state.createdAt = saved.createdAt;
    if (saved._storageKey) this.state._storageKey = saved._storageKey;

    // Go to the step they left off, or step 1
    this.state.currentStep = saved.currentStep || 1;
    this.render();
  };

  /* ── Main Render ── */
  MCWBuilder.prototype.render = function () {
    this.root.innerHTML = '';

    var builder = el('div', { className: 'mcw-builder' });

    // Header
    builder.appendChild(this.renderHeader());

    // Progress bar
    builder.appendChild(this.renderProgressBar());

    // Content area
    this._contentEl = el('div', { className: 'mcw-builder-content' });
    builder.appendChild(this._contentEl);

    // Footer CTA
    this._footerEl = el('div', { className: 'mcw-builder-footer' });
    builder.appendChild(this._footerEl);

    this.root.appendChild(builder);

    // Push initial history state
    this.pushStep(this.state.currentStep, true);

    // Render current step
    this.renderStep();
  };

  MCWBuilder.prototype.renderHeader = function () {
    var self = this;
    return el('div', { className: 'mcw-builder-header' }, [
      el('div', { className: 'mcw-builder-header-inner' }, [
        el('div', { className: 'mcw-builder-header-spacer' }),
        el('span', { className: 'mcw-step-indicator', id: 'mcw-step-label' },
          'Step ' + this.state.currentStep + ' of 4'),
        el('button', { className: 'mcw-save-exit', onClick: function () { self.saveAndExit(); } }, 'Save & Exit')
      ])
    ]);
  };

  var STEP_TOOLTIPS = [
    '1 · Upload your photos',
    '2 · Crop & organize',
    '3 · Customize your book',
    '4 · Review your order'
  ];

  MCWBuilder.prototype.renderProgressBar = function () {
    var bar = el('div', { className: 'mcw-progress-bar', id: 'mcw-progress-bar' });
    for (var i = 1; i <= 4; i++) {
      var cls = 'mcw-progress-segment';
      if (i < this.state.currentStep) cls += ' completed';
      if (i === this.state.currentStep) cls += ' active';
      bar.appendChild(el('div', {
        className: cls,
        title: STEP_TOOLTIPS[i - 1],
        'data-tooltip': STEP_TOOLTIPS[i - 1],
        'aria-label': STEP_TOOLTIPS[i - 1],
        tabindex: '0'
      }));
    }
    return bar;
  };

  MCWBuilder.prototype.updateProgressBar = function () {
    var label = qs('#mcw-step-label');
    if (label) label.textContent = 'Step ' + this.state.currentStep + ' of 4';

    var bar = qs('#mcw-progress-bar');
    if (bar) {
      var segments = qsa('.mcw-progress-segment', bar);
      segments.forEach(function (seg, i) {
        seg.className = 'mcw-progress-segment';
        if (i + 1 < this.state.currentStep) seg.classList.add('completed');
        if (i + 1 === this.state.currentStep) seg.classList.add('active');
      }.bind(this));
    }
  };

  /* ── Step Navigation ── */
  MCWBuilder.prototype.goToStep = function (step) {
    if (step < 1 || step > 4) return;
    this.state.currentStep = step;
    this.pushStep(step);
    this.renderStep();
    this.saveSession();
    // Scroll to the top of the builder so the user clearly sees the new step
    var root = qs('#mcw-builder-app') || qs('[data-builder-root]');
    var y = root ? root.getBoundingClientRect().top + window.pageYOffset - 16 : 0;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  };

  MCWBuilder.prototype.pushStep = function (step, replace) {
    var url = new URL(window.location.href);
    url.searchParams.set('step', step);
    var stateObj = { mcwStep: step };
    if (replace) {
      history.replaceState(stateObj, '', url.toString());
    } else {
      history.pushState(stateObj, '', url.toString());
    }
  };

  MCWBuilder.prototype.renderStep = function () {
    this.updateProgressBar();

    // Animate transition
    if (this._contentEl) {
      this._contentEl.classList.remove('mcw-step-enter');
      void this._contentEl.offsetWidth; // force reflow
      this._contentEl.classList.add('mcw-step-enter');
    }

    switch (this.state.currentStep) {
      case 1: this.renderStep1(); break;
      case 2: this.renderStep2(); break;
      case 3: this.renderStep3(); break;
      case 4: this.renderStep4(); break;
    }
  };

  MCWBuilder.prototype.saveSession = function () {
    SessionStore.save(this.state.productHandle, {
      photos: this.state.photos.map(function (p) {
        // Never persist blob: URLs — they die with the session that created them.
        var thumb = (p.thumbUrl && !/^blob:/i.test(p.thumbUrl)) ? p.thumbUrl : p.url;
        return { id: p.id, url: p.url, thumbUrl: thumb, filename: p.filename, status: p.status, order: p.order };
      }),
      variantId: this.state.variantId,
      coverSelected: this.state.coverSelected,
      coverPhotoUrl: this.state.coverPhotoUrl,
      coverText: this.state.coverText,
      currentStep: this.state.currentStep,
      sessionId: this.state.sessionId,
      createdAt: this.state.createdAt,
      _storageKey: this.state._storageKey
    });
  };

  MCWBuilder.prototype.saveAndExit = function () {
    this.saveSession();
    // Redirect to the product page
    var productUrl = '/products/' + this.state.productHandle;
    window.location.href = productUrl;
  };

  /* ── STEP 1: Upload Photos ── */
  MCWBuilder.prototype.renderStep1 = function () {
    var self = this;
    var content = this._contentEl;
    content.innerHTML = '';

    // Title — H2 with an inline purple "Under 5 minutes" subtitle to set
    // a fast expectation without taking its own row.
    content.appendChild(el('span', { className: 'mcw-kicker' }, 'Step 1 · Photos'));
    content.appendChild(el('h2', null, [
      'Upload your photos ',
      el('span', { className: 'mcw-step-heading-time' }, '— Under 5 minutes')
    ]));
    content.appendChild(el('p', { className: 'mcw-threshold-info' },
      'Pick ' + this.state.minPhotos + '–' + this.state.maxPhotos + ' photos that tell your story. We’ll turn each one into a hand-finished coloring page. Upload them as they are — you’ll be able to crop and adjust each photo in the next step.'));

    // Upload zone
    var fileInput = el('input', {
      type: 'file',
      className: 'mcw-upload-input',
      id: 'mcw-file-input',
      multiple: 'true',
      accept: 'image/jpeg,image/png,image/heic,image/heif,image/webp'
    });
    fileInput.addEventListener('change', function (e) {
      self.handleFiles(e.target.files);
      e.target.value = ''; // allow re-selecting same files
    });

    var uploadZone = el('div', {
      className: 'mcw-upload-zone',
      id: 'mcw-upload-zone',
      onClick: function () { fileInput.click(); }
    }, [
      el('div', {
        className: 'mcw-upload-zone-icon',
        innerHTML: '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<defs><linearGradient id="mcw-illo-photo" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" stop-color="#FBDADA"/><stop offset="100%" stop-color="#F4B6C5"/>' +
          '</linearGradient></defs>' +
          '<g transform="translate(10 28) rotate(-6 30 30)">' +
          '<rect width="58" height="58" rx="8" fill="url(#mcw-illo-photo)" stroke="#E38AA5" stroke-width="1.5"/>' +
          '<circle cx="20" cy="22" r="6" fill="#FFF5C7"/>' +
          '<path d="M6 52 C 18 34, 28 40, 58 48 L 58 58 L 6 58 Z" fill="#C9AFC3" opacity=".8"/>' +
          '</g>' +
          '<path d="M62 60 L74 60" stroke="#6B2D8B" stroke-width="2.4" stroke-linecap="round"/>' +
          '<path d="M70 56 L76 60 L70 64" stroke="#6B2D8B" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
          '<g transform="translate(60 28) rotate(6 30 30)">' +
          '<rect width="58" height="58" rx="8" fill="#fff" stroke="#6B2D8B" stroke-width="1.5"/>' +
          '<circle cx="20" cy="22" r="6" fill="none" stroke="#2B1E3F" stroke-width="1.4"/>' +
          '<path d="M6 52 C 18 34, 28 40, 58 48" fill="none" stroke="#2B1E3F" stroke-width="1.4" stroke-linecap="round"/>' +
          '<path d="M14 56 L22 56 M30 54 L38 56 M46 52 L54 54" stroke="#2B1E3F" stroke-width="1.4" stroke-linecap="round"/>' +
          '</g></svg>'
      }),
      el('div', { className: 'mcw-upload-zone-text' }, 'Drop photos here or tap to browse'),
      el('div', {
        className: 'mcw-upload-zone-subtext',
        innerHTML: '<code>JPG</code> \u00b7 <code>PNG</code> \u00b7 <code>HEIC</code> \u2003\u00b7 up to 25MB each'
      }),
      fileInput
    ]);

    // Drag & drop on upload zone
    uploadZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', function () {
      uploadZone.classList.remove('dragover');
    });
    uploadZone.addEventListener('drop', function (e) {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      self.handleFiles(e.dataTransfer.files);
    });

    content.appendChild(uploadZone);

    // Rejected-files panel (populated by renderRejectedPanel when over-max drops happen)
    content.appendChild(el('div', { id: 'mcw-rejected-panel', className: 'mcw-rejected-panel', style: 'display:none;' }));
    this.renderRejectedPanel();

    // Photo counter
    content.appendChild(this.renderPhotoCounter());

    // Threshold message
    content.appendChild(el('div', { id: 'mcw-threshold-msg' }));
    this.updateThresholdDisplay();

    // Photo grid
    var grid = el('div', { className: 'mcw-photo-grid', id: 'mcw-photo-grid' });
    content.appendChild(grid);
    this.renderPhotoGrid();

    // Error banner container
    content.insertBefore(el('div', { id: 'mcw-error-banner' }), content.firstChild);

    // Footer: progress label on left, pink CTA pill on right
    this._footerEl.innerHTML = '';
    var progressEl = el('div', { className: 'mcw-footer-progress', id: 'mcw-footer-progress' });
    var continueBtn = el('button', {
      className: 'mcw-btn-primary',
      id: 'mcw-continue-btn',
      onClick: function () { self.goToStep(2); }
    }, ['Continue ', el('span', { className: 'mcw-btn-arrow', 'aria-hidden': 'true' }, '\u2192')]);
    this._footerEl.appendChild(el('div', { className: 'mcw-footer-row' }, [progressEl, continueBtn]));
    this.updateContinueButton();
  };

  MCWBuilder.prototype.handleFiles = function (fileList) {
    var self = this;
    var files = Array.from(fileList);
    var readyCount = this.state.photos.filter(function (p) { return p.status !== 'error'; }).length;

    files.forEach(function (file) {
      // Hard reject once we'd exceed the book's max — but capture file + thumb
      // so the rejected panel can show it and offer a one-tap retry later.
      if (readyCount >= self.state.maxPhotos) {
        self.state.rejectedFiles.push({
          id: 'rej_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          name: file.name,
          thumbUrl: URL.createObjectURL(file),
          file: file
        });
        return;
      }

      // Validate type
      var ext = file.name.split('.').pop().toLowerCase();
      var isAccepted = ACCEPTED_TYPES.indexOf(file.type) !== -1 ||
                       ['heic', 'heif', 'jpg', 'jpeg', 'png', 'webp'].indexOf(ext) !== -1;
      if (!isAccepted) {
        self.showToast('Unsupported file type: ' + file.name);
        return;
      }

      // Validate size
      if (file.size > MAX_FILE_SIZE) {
        self.showToast(file.name + ' is too large (max 25MB)');
        return;
      }

      var photoId = 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      var photo = {
        id: photoId,
        url: '',
        thumbUrl: URL.createObjectURL(file),
        filename: file.name,
        status: 'queued',
        order: self.state.photos.length,
        _file: file,
        progress: 0
      };

      self.state.photos.push(photo);
      readyCount++;
    });

    this.renderPhotoGrid();
    this.updatePhotoCounter();
    this.updateThresholdDisplay();
    this.renderRejectedPanel();
    this.updateContinueButton();
    this.processUploadQueue();
  };

  MCWBuilder.prototype.renderRejectedPanel = function () {
    var self = this;
    var panel = qs('#mcw-rejected-panel');
    if (!panel) return;
    panel.innerHTML = '';
    if (!this.state.rejectedFiles.length) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';

    var count = this.state.rejectedFiles.length;
    var header = el('div', { className: 'mcw-rejected-header' }, [
      el('div', { className: 'mcw-rejected-title' },
        'You’ve reached the ' + this.state.maxPhotos + '-photo max. ' +
        count + ' photo' + (count > 1 ? 's weren’t' : ' wasn’t') + ' added.'),
      el('button', {
        className: 'mcw-rejected-dismiss',
        'aria-label': 'Dismiss',
        onClick: function () { self.dismissRejected(); },
        innerHTML: '&times;'
      })
    ]);
    panel.appendChild(header);

    panel.appendChild(el('div', { className: 'mcw-rejected-hint' },
      'Delete any photo below to make room, then tap any thumbnail to add it instead.'));

    var grid = el('div', { className: 'mcw-rejected-grid' });
    this.state.rejectedFiles.forEach(function (r) {
      var tile = el('div', {
        className: 'mcw-rejected-tile',
        role: 'button',
        tabindex: '0',
        'aria-label': 'Retry ' + r.name,
        onClick: function () { self.retryRejectedFile(r.id); }
      }, [
        el('img', { src: r.thumbUrl, alt: r.name, loading: 'lazy' }),
        el('div', { className: 'mcw-rejected-name' }, r.name),
        el('div', { className: 'mcw-rejected-retry' }, 'Tap to add')
      ]);
      grid.appendChild(tile);
    });
    panel.appendChild(grid);
  };

  MCWBuilder.prototype.retryRejectedFile = function (id) {
    var idx = this.state.rejectedFiles.findIndex(function (r) { return r.id === id; });
    if (idx === -1) return;
    var entry = this.state.rejectedFiles[idx];
    // If we're still at max, retry will just bounce it back — tell the user why.
    var readyCount = this.state.photos.filter(function (p) { return p.status !== 'error'; }).length;
    if (readyCount >= this.state.maxPhotos) {
      this.showToast('Delete a photo first to make room.');
      return;
    }
    // Release the rejected-side blob URL and hand the File back to the normal flow.
    URL.revokeObjectURL(entry.thumbUrl);
    this.state.rejectedFiles.splice(idx, 1);
    this.handleFiles([entry.file]);
  };

  MCWBuilder.prototype.dismissRejected = function () {
    this.state.rejectedFiles.forEach(function (r) {
      URL.revokeObjectURL(r.thumbUrl);
    });
    this.state.rejectedFiles = [];
    this.renderRejectedPanel();
  };

  MCWBuilder.prototype.processUploadQueue = function () {
    var self = this;
    var queued = this.state.photos.filter(function (p) { return p.status === 'queued'; });

    while (this._activeUploads < MAX_CONCURRENT_UPLOADS && queued.length > 0) {
      var photo = queued.shift();
      this._activeUploads++;
      photo.status = 'uploading';
      this.updatePhotoUI(photo);

      (function (p) {
        self.uploader.processAndUpload(
          p._file,
          self.state.sessionId,
          // onProgress
          function (pct) {
            p.progress = pct;
            self.updatePhotoProgress(p);
          },
          // onStatusChange
          function (status) {
            if (status === 'converting') {
              p.status = 'converting';
              self.updatePhotoUI(p);
            }
          }
        ).then(function (result) {
          p.url = result.publicUrl;
          p.status = 'ready';
          p.progress = 1;
          delete p._file;
          self._activeUploads--;
          self.updatePhotoUI(p);
          self.updatePhotoCounter();
          self.updateThresholdDisplay();
          self.updateContinueButton();
          self.saveSession();
          self.processUploadQueue();
        }).catch(function (err) {
          console.error('Upload failed for', p.filename, err);
          p.status = 'error';
          p.errorMsg = err.message === 'HEIC_CONVERSION_FAILED'
            ? "Couldn't process this photo. Try taking a screenshot and uploading that instead."
            : 'Upload failed. Tap to retry.';
          // Keep _file on the photo so retry can re-queue without the user re-picking.
          self._activeUploads--;
          self.updatePhotoUI(p);
          self.updateThresholdDisplay();
          self.updateContinueButton();
          self.processUploadQueue();
        });
      })(photo);
    }
  };

  /* ── Photo Grid Rendering ── */
  MCWBuilder.prototype.renderPhotoGrid = function () {
    var grid = qs('#mcw-photo-grid');
    if (!grid) return;
    // Preserve reorderable mode across re-renders — without this, the first drop
    // drops drag handlers on subsequent tiles and the user can only reorder once.
    var reorderable = grid.classList.contains('reorderable');
    // On Step 2 we only want ready photos (no in-flight uploads in the reorder view).
    var photos = reorderable
      ? this.state.photos.filter(function (p) { return p.status === 'ready'; })
      : this.state.photos;
    grid.innerHTML = '';

    var self = this;
    photos.forEach(function (photo, idx) {
      grid.appendChild(self.createPhotoItem(photo, reorderable, idx + 1));
    });
  };

  MCWBuilder.prototype.createPhotoItem = function (photo, reorderable, position) {
    var self = this;
    var item = el('div', { className: 'mcw-photo-item', 'data-id': photo.id });

    // Position number — primary visual cue for "which page in the book am I?"
    // Rendered on every tile so Step 1's grid shows upload order too.
    if (position) {
      item.appendChild(el('div', { className: 'mcw-photo-position' }, String(position)));
    }

    // Thumbnail image.
    // crossOrigin MUST be set before src so the browser sends an Origin header.
    // Without it, CloudFront caches a no-CORS response under the same cache key
    // (CachingOptimized ignores query strings), which poisons later crop fetches.
    var imgSrc = photo.thumbUrl || photo.url;
    if (imgSrc) {
      var thumbImg = document.createElement('img');
      thumbImg.crossOrigin = 'anonymous';
      thumbImg.alt = photo.filename || 'Photo';
      thumbImg.loading = 'lazy';
      thumbImg.src = imgSrc;
      item.appendChild(thumbImg);
    }

    // Status overlay for uploading/converting
    if (photo.status === 'uploading' || photo.status === 'converting' || photo.status === 'compressing' || photo.status === 'queued') {
      var statusText = photo.status === 'converting' ? 'Converting iPhone photo...'
        : photo.status === 'compressing' ? 'Processing...'
        : photo.status === 'queued' ? 'Waiting...'
        : 'Uploading...';
      item.appendChild(el('div', { className: 'mcw-photo-status' }, [
        el('div', { className: 'spinner' }),
        el('span', null, statusText)
      ]));
      // Progress bar
      var progressBar = el('div', { className: 'mcw-photo-progress' }, [
        el('div', {
          className: 'mcw-photo-progress-bar',
          style: 'width:' + Math.round((photo.progress || 0) * 100) + '%'
        })
      ]);
      item.appendChild(progressBar);
    }

    // Error overlay — tap anywhere on the tile to retry
    if (photo.status === 'error') {
      var errorOverlay = el('div', {
        className: 'mcw-photo-status mcw-photo-error',
        role: 'button',
        tabindex: '0',
        'aria-label': 'Retry upload',
        onClick: function (e) {
          e.stopPropagation();
          self.retryPhoto(photo.id);
        }
      }, [
        el('div', { className: 'mcw-photo-error-icon', innerHTML: '&#x21bb;' }),
        el('div', { className: 'mcw-photo-error-msg' }, photo.errorMsg || 'Upload failed'),
        el('div', { className: 'mcw-photo-error-cta' }, 'Tap to retry')
      ]);
      item.appendChild(errorOverlay);
    }

    // Delete button (always available except during upload)
    if (photo.status === 'ready' || photo.status === 'error') {
      var deleteBtn = el('button', {
        className: 'mcw-photo-delete',
        'aria-label': 'Remove photo',
        onClick: function (e) {
          e.stopPropagation();
          self.removePhoto(photo.id);
        }
      }, '\u00d7');
      item.appendChild(deleteBtn);
    }

    // Overlay: crop action on Step 2 (reorderable), expand-to-preview on Step 1
    if (photo.status === 'ready') {
      if (reorderable) {
        var cropOverlay = el('div', { className: 'mcw-photo-overlay' }, [
          el('button', {
            className: 'mcw-photo-action',
            'aria-label': 'Crop photo',
            onClick: function (e) {
              e.stopPropagation();
              self.openCropModal(photo);
            },
            innerHTML: '&#9986;'
          })
        ]);
        item.appendChild(cropOverlay);
      } else {
        var previewOverlay = el('div', { className: 'mcw-photo-overlay mcw-photo-overlay--preview' }, [
          el('button', {
            className: 'mcw-photo-action',
            'aria-label': 'Preview photo',
            onClick: function (e) {
              e.stopPropagation();
              self.openPreviewModal(photo);
            },
            innerHTML: '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="M11 11 l3.5 3.5"/></svg>'
          })
        ]);
        item.appendChild(previewOverlay);
        item.style.cursor = 'zoom-in';
        item.addEventListener('click', function (e) {
          if (e.target.closest('.mcw-photo-delete, .mcw-photo-action, .mcw-photo-error')) return;
          self.openPreviewModal(photo);
        });
      }
    }

    // Drag handle for reorder mode
    if (reorderable) {
      item.appendChild(el('div', { className: 'mcw-drag-handle', innerHTML: '&#9776;' }));
      item.setAttribute('draggable', 'true');
      this.attachDragHandlers(item, photo);
    }

    return item;
  };

  MCWBuilder.prototype.updatePhotoUI = function (photo) {
    var grid = qs('#mcw-photo-grid');
    if (!grid) return;
    var existing = qs('[data-id="' + photo.id + '"]', grid);
    var reorderable = grid.classList.contains('reorderable');
    // Recompute position among the same set of photos we're rendering — ready-only
    // on Step 2, all-photos otherwise — so the badge stays correct after updates.
    var visiblePhotos = reorderable
      ? this.state.photos.filter(function (p) { return p.status === 'ready'; })
      : this.state.photos;
    var position = visiblePhotos.findIndex(function (p) { return p.id === photo.id; }) + 1;
    var newItem = this.createPhotoItem(photo, reorderable, position || undefined);
    if (existing) {
      grid.replaceChild(newItem, existing);
    } else {
      grid.appendChild(newItem);
    }
  };

  MCWBuilder.prototype.updatePhotoProgress = function (photo) {
    var item = qs('[data-id="' + photo.id + '"] .mcw-photo-progress-bar');
    if (item) item.style.width = Math.round((photo.progress || 0) * 100) + '%';
  };

  MCWBuilder.prototype.retryPhoto = function (photoId) {
    var photo = this.state.photos.find(function (p) { return p.id === photoId; });
    if (!photo || !photo._file) return;
    photo.status = 'queued';
    photo.progress = 0;
    photo.errorMsg = null;
    this.updatePhotoUI(photo);
    this.processUploadQueue();
  };

  MCWBuilder.prototype.removePhoto = function (photoId) {
    var self = this;
    var idx = this.state.photos.findIndex(function (p) { return p.id === photoId; });
    if (idx === -1) return;

    var removed = this.state.photos.splice(idx, 1)[0];

    // Re-index order
    this.state.photos.forEach(function (p, i) { p.order = i; });

    this.renderPhotoGrid();
    this.updateThresholdDisplay();
    this.updateContinueButton();
    this.updatePhotoCounter();
    this.saveSession();

    // Show undo toast
    this.showUndoToast('Photo removed', function () {
      // Undo — re-insert at original index
      removed.order = idx;
      self.state.photos.splice(idx, 0, removed);
      self.state.photos.forEach(function (p, i) { p.order = i; });
      self.renderPhotoGrid();
      self.updateThresholdDisplay();
      self.updateContinueButton();
      self.updatePhotoCounter();
      self.saveSession();
    });
  };

  /* ── Photo Counter ── */
  MCWBuilder.prototype.renderPhotoCounter = function () {
    var readyCount = this.getReadyPhotoCount();
    var pct = Math.min(100, Math.round((readyCount / this.state.maxPhotos) * 100));
    var overMax = readyCount > this.state.maxPhotos;

    return el('div', { className: 'mcw-photo-counter', id: 'mcw-photo-counter' }, [
      el('span', { className: 'mcw-counter-text' },
        readyCount + ' of ' + (this.state.pageCount || this.state.maxPhotos) + ' photos'),
      el('div', { className: 'mcw-counter-bar' }, [
        el('div', {
          className: 'mcw-counter-fill' + (overMax ? ' over-max' : ''),
          style: 'width:' + pct + '%'
        })
      ])
    ]);
  };

  MCWBuilder.prototype.updatePhotoCounter = function () {
    var container = qs('#mcw-photo-counter');
    if (!container) return;
    var newCounter = this.renderPhotoCounter();
    container.replaceWith(newCounter);
  };

  MCWBuilder.prototype.getReadyPhotoCount = function () {
    return this.state.photos.filter(function (p) { return p.status === 'ready'; }).length;
  };

  /* ── Threshold Display ── */
  MCWBuilder.prototype.updateThresholdDisplay = function () {
    var msgEl = qs('#mcw-threshold-msg');
    if (!msgEl) return;
    msgEl.innerHTML = '';

    var count = this.getReadyPhotoCount();
    var min = this.state.minPhotos;
    var max = this.state.maxPhotos;

    if (count < min) {
      msgEl.appendChild(el('div', { className: 'mcw-threshold-warning' },
        'You need at least ' + min + ' photos to continue. Add ' + (min - count) + ' more.'));
    } else if (count > max) {
      var excess = count - max;
      msgEl.appendChild(el('div', { className: 'mcw-threshold-warning' },
        'You have ' + count + ' photos but your book allows a maximum of ' + max + '. Remove ' + excess + ' photo' + (excess > 1 ? 's' : '') + ' or upgrade to a larger book.'));
    } else if (count >= min && count <= max) {
      msgEl.appendChild(el('div', { className: 'mcw-threshold-ok' },
        count + ' photos ready — continue when you are!'));
    }

    // Disable upload zone at max
    var zone = qs('#mcw-upload-zone');
    var fileInput = qs('#mcw-file-input');
    if (zone && fileInput) {
      if (count >= max) {
        zone.style.opacity = '0.5';
        zone.style.pointerEvents = 'none';
        fileInput.disabled = true;
      } else {
        zone.style.opacity = '';
        zone.style.pointerEvents = '';
        fileInput.disabled = false;
      }
    }
  };

  MCWBuilder.prototype.updateContinueButton = function () {
    var btn = qs('#mcw-continue-btn');
    if (!btn) return;
    var count = this.getReadyPhotoCount();
    var min = this.state.minPhotos;
    var max = this.state.maxPhotos;
    var hasUploading = this.state.photos.some(function (p) {
      return p.status === 'uploading' || p.status === 'converting' || p.status === 'queued';
    });
    btn.disabled = count < min || count > max || hasUploading;

    var progress = qs('#mcw-footer-progress');
    if (progress) {
      var step = this.state.currentStep;
      var html = '';
      if (hasUploading) {
        html = '<strong>' + count + ' of ' + max + '</strong> photos · finishing uploads…';
      } else if (count < min) {
        var need = min - count;
        html = '<strong>' + count + ' of ' + max + '</strong> photos · add ' + need + ' more to continue';
      } else if (count > max) {
        html = '<strong>' + count + '</strong> photos · remove ' + (count - max) + ' to continue';
      } else if (step === 2) {
        html = '<strong>' + count + ' photos</strong> · drag to reorder, then continue';
      } else if (step === 3) {
        html = '<strong>' + count + ' photos</strong> · review your order next';
      } else {
        html = '<strong>' + count + ' of ' + max + '</strong> photos · add more or continue';
      }
      progress.innerHTML = html;
    }
  };

  /* ── STEP 2: Review & Reorder ── */
  MCWBuilder.prototype.renderStep2 = function () {
    var self = this;
    var content = this._contentEl;
    content.innerHTML = '';

    // Only show ready photos
    var readyPhotos = this.state.photos.filter(function (p) { return p.status === 'ready'; });

    content.appendChild(el('span', { className: 'mcw-kicker' }, 'Step 2 · Crop & Organize'));
    content.appendChild(el('h2', null, 'Crop & organize'));
    content.appendChild(el('p', { className: 'mcw-threshold-info' },
      'The number on each photo is its page order. Drag any photo to a new spot to reorder, or tap to crop.'));

    // Threshold message
    content.appendChild(el('div', { id: 'mcw-threshold-msg' }));
    this.updateThresholdDisplay();

    // Photo grid (reorderable) — the primary focus of this step
    var grid = el('div', { className: 'mcw-photo-grid reorderable', id: 'mcw-photo-grid' });
    readyPhotos.forEach(function (photo, idx) {
      grid.appendChild(self.createPhotoItem(photo, true, idx + 1));
    });
    content.appendChild(grid);

    // Setup touch reorder for mobile
    this.setupTouchReorder(grid);

    // "Add more" comes after the grid so Step 2 reads as a reorder view first
    content.appendChild(el('button', {
      className: 'mcw-btn-secondary',
      style: 'margin-top:24px;',
      onClick: function () { self.goToStep(1); }
    }, '+ Add More Photos'));

    // Footer: progress label on left, pink CTA pill on right
    this._footerEl.innerHTML = '';
    var progressEl = el('div', { className: 'mcw-footer-progress', id: 'mcw-footer-progress' });
    var continueBtn = el('button', {
      className: 'mcw-btn-primary',
      id: 'mcw-continue-btn',
      onClick: function () { self.goToStep(3); }
    }, ['Continue ', el('span', { className: 'mcw-btn-arrow', 'aria-hidden': 'true' }, '\u2192')]);
    var backLink = el('button', { className: 'mcw-back-link', style: 'background:none;border:0;padding:8px 6px;color:#004a70;text-decoration:underline;cursor:pointer;font:inherit;font-size:0.95rem;', onClick: function () { self.goToStep(1); } }, ['\u2190 Back']);
    this._footerEl.appendChild(el('div', { className: 'mcw-footer-row' }, [progressEl, el('div', { className: 'mcw-footer-actions', style: 'display:flex;gap:14px;align-items:center;' }, [backLink, continueBtn])]));
    this.updateContinueButton();
  };

  /* ── Drag & Drop Reorder ── */
  MCWBuilder.prototype.attachDragHandlers = function (itemEl, photo) {
    var self = this;

    itemEl.addEventListener('dragstart', function (e) {
      self._dragState = { photoId: photo.id, startIndex: photo.order };
      itemEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', photo.id);
    });

    itemEl.addEventListener('dragend', function () {
      itemEl.classList.remove('dragging');
      qsa('.mcw-photo-item.drag-over').forEach(function (el) {
        el.classList.remove('drag-over');
      });
      self._dragState = null;
    });

    itemEl.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      itemEl.classList.add('drag-over');
    });

    itemEl.addEventListener('dragleave', function () {
      itemEl.classList.remove('drag-over');
    });

    itemEl.addEventListener('drop', function (e) {
      e.preventDefault();
      itemEl.classList.remove('drag-over');
      if (!self._dragState) return;

      var draggedId = self._dragState.photoId;
      var targetId = photo.id;
      if (draggedId === targetId) return;

      self.reorderPhotos(draggedId, targetId);
    });
  };

  MCWBuilder.prototype.setupTouchReorder = function (grid) {
    var self = this;
    var touchState = null;
    var placeholder = null;

    grid.addEventListener('touchstart', function (e) {
      var handle = e.target.closest('.mcw-drag-handle');
      if (!handle) return;

      var item = handle.closest('.mcw-photo-item');
      if (!item) return;

      var photoId = item.getAttribute('data-id');
      var touch = e.touches[0];

      touchState = {
        photoId: photoId,
        startY: touch.clientY,
        startX: touch.clientX,
        el: item,
        rect: item.getBoundingClientRect()
      };

      item.style.zIndex = '10';
      item.classList.add('dragging');
    }, { passive: true });

    grid.addEventListener('touchmove', function (e) {
      if (!touchState) return;
      e.preventDefault();

      var touch = e.touches[0];
      var dx = touch.clientX - touchState.startX;
      var dy = touch.clientY - touchState.startY;
      touchState.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(0.95)';

      // Find element under touch point
      touchState.el.style.pointerEvents = 'none';
      var elemBelow = document.elementFromPoint(touch.clientX, touch.clientY);
      touchState.el.style.pointerEvents = '';

      var targetItem = elemBelow ? elemBelow.closest('.mcw-photo-item') : null;
      qsa('.mcw-photo-item.drag-over', grid).forEach(function (el) { el.classList.remove('drag-over'); });
      if (targetItem && targetItem !== touchState.el) {
        targetItem.classList.add('drag-over');
        touchState.currentTarget = targetItem.getAttribute('data-id');
      }
    }, { passive: false });

    grid.addEventListener('touchend', function () {
      if (!touchState) return;
      touchState.el.style.transform = '';
      touchState.el.style.zIndex = '';
      touchState.el.classList.remove('dragging');

      qsa('.mcw-photo-item.drag-over', grid).forEach(function (el) { el.classList.remove('drag-over'); });

      if (touchState.currentTarget && touchState.currentTarget !== touchState.photoId) {
        self.reorderPhotos(touchState.photoId, touchState.currentTarget);
      }

      touchState = null;
    }, { passive: true });
  };

  MCWBuilder.prototype.reorderPhotos = function (draggedId, targetId) {
    var photos = this.state.photos;
    var dragIdx = photos.findIndex(function (p) { return p.id === draggedId; });
    var targetIdx = photos.findIndex(function (p) { return p.id === targetId; });
    if (dragIdx === -1 || targetIdx === -1) return;

    // Move dragged photo to target position
    var dragged = photos.splice(dragIdx, 1)[0];
    photos.splice(targetIdx, 0, dragged);

    // Re-index
    photos.forEach(function (p, i) { p.order = i; });

    this.renderPhotoGrid();
    this.saveSession();
  };

  /* ── Crop Modal (Cropper.js) ── */
  MCWBuilder.prototype.openCropModal = function (photo) {
    var self = this;

    // Page aspect is 8.5×11 (portrait). Landscape pages are rotated 90° at
    // print time so they occupy a full portrait page rotated sideways.
    var PORTRAIT_RATIO = 8.5 / 11;
    var LANDSCAPE_RATIO = 11 / 8.5;
    var orientation = 'portrait';

    // Create modal
    var modal = el('div', { className: 'mcw-crop-modal', id: 'mcw-crop-modal' });

    // Header
    var header = el('div', { className: 'mcw-crop-header' }, [
      el('button', {
        className: 'mcw-crop-cancel',
        onClick: function () { self.closeCropModal(); }
      }, 'Cancel'),
      el('span', null, 'Crop Photo'),
      el('button', {
        className: 'mcw-crop-apply',
        onClick: function () { self.applyCrop(photo); }
      }, 'Apply')
    ]);
    modal.appendChild(header);

    // Orientation toggle
    var portraitIcon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="1.5" width="8" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5"/></svg>';
    var landscapeIcon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/></svg>';

    var portraitBtn = el('button', {
      type: 'button',
      className: 'mcw-crop-orient-btn mcw-crop-orient-active',
      'aria-pressed': 'true',
      innerHTML: portraitIcon + '<span>Portrait</span>'
    });
    var landscapeBtn = el('button', {
      type: 'button',
      className: 'mcw-crop-orient-btn',
      'aria-pressed': 'false',
      innerHTML: landscapeIcon + '<span>Landscape</span>'
    });
    var orientHint = el('div', { className: 'mcw-crop-orient-hint' },
      'Portrait pages print upright. Tap Landscape to crop sideways — those pages will rotate in the printed book.');

    var setOrientation = function (next) {
      if (next === orientation) return;
      orientation = next;
      var isLandscape = next === 'landscape';
      portraitBtn.classList.toggle('mcw-crop-orient-active', !isLandscape);
      landscapeBtn.classList.toggle('mcw-crop-orient-active', isLandscape);
      portraitBtn.setAttribute('aria-pressed', isLandscape ? 'false' : 'true');
      landscapeBtn.setAttribute('aria-pressed', isLandscape ? 'true' : 'false');
      if (self.cropper) {
        self.cropper.setAspectRatio(isLandscape ? LANDSCAPE_RATIO : PORTRAIT_RATIO);
      }
    };
    portraitBtn.addEventListener('click', function () { setOrientation('portrait'); });
    landscapeBtn.addEventListener('click', function () { setOrientation('landscape'); });

    var toggleRow = el('div', { className: 'mcw-crop-toggle-row' }, [
      el('div', { className: 'mcw-crop-toggle', role: 'group', 'aria-label': 'Crop orientation' },
        [portraitBtn, landscapeBtn]),
      orientHint
    ]);
    modal.appendChild(toggleRow);

    // Helper text under header
    var hint = el('div', { className: 'mcw-crop-hint' },
      'Drag to reposition · pinch/scroll to zoom · drag the edges to resize the crop');
    modal.appendChild(hint);

    // Image container
    // crossOrigin must be set BEFORE src; otherwise the browser begins the
    // request without CORS and the canvas gets tainted at apply time.
    var container = el('div', { className: 'mcw-crop-container' });
    var img = document.createElement('img');
    img.id = 'mcw-crop-image';
    img.crossOrigin = 'anonymous';
    // Cache-buster: CloudFront's CachingOptimized policy doesn't include the
    // Origin header in the cache key, so a non-CORS request (grid tile, browser
    // preload, anything) can populate the cache with a response that lacks
    // `access-control-allow-origin`. A unique `?cors=<ts>` per attempt
    // guarantees a cache miss → fresh origin fetch → CORS headers applied.
    var cropSrc = photo.url || photo.thumbUrl;
    img.src = cropSrc + (cropSrc.indexOf('?') >= 0 ? '&' : '?') + 'cors=' + Date.now();
    container.appendChild(img);
    modal.appendChild(container);

    document.body.appendChild(modal);

    // Cropper.js needs the image to be loaded before it can compute dimensions.
    // Initializing early leaves the user with a bare photo and no crop box.
    var initCropper = function () {
      if (typeof Cropper === 'undefined') return;
      self.cropper = new Cropper(img, {
        aspectRatio: PORTRAIT_RATIO,
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 0.9,
        responsive: true,
        restore: false,
        guides: true,
        center: true,
        highlight: true,   // dim area outside crop box
        background: true,  // show checkered backdrop
        modal: true,       // dark backdrop behind image
        movable: true,
        rotatable: false,
        scalable: false,
        zoomable: true,
        zoomOnTouch: true,
        zoomOnWheel: true,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: false
      });
    };
    if (img.complete && img.naturalWidth > 0) {
      initCropper();
    } else {
      img.addEventListener('load', initCropper, { once: true });
      img.addEventListener('error', function () {
        console.error('Crop: image failed to load', img.src);
        self.showToast("Couldn't load photo for cropping. Please try again.");
        self.closeCropModal();
      }, { once: true });
    }
  };

  MCWBuilder.prototype.closeCropModal = function () {
    if (this.cropper) {
      this.cropper.destroy();
      this.cropper = null;
    }
    var modal = qs('#mcw-crop-modal');
    if (modal) modal.remove();
  };

  MCWBuilder.prototype.openPreviewModal = function (photo) {
    var self = this;
    var modal = el('div', { className: 'mcw-preview-modal', id: 'mcw-preview-modal', role: 'dialog', 'aria-label': 'Photo preview' });

    var close = function () { self.closePreviewModal(); };

    modal.appendChild(el('button', {
      className: 'mcw-preview-close',
      'aria-label': 'Close preview',
      onClick: close,
      innerHTML: '&times;'
    }));

    var img = document.createElement('img');
    img.className = 'mcw-preview-image';
    img.alt = photo.filename || 'Photo preview';
    // crossOrigin must be set before src — see thumbnail comment above.
    img.crossOrigin = 'anonymous';
    img.src = photo.url || photo.thumbUrl;
    img.addEventListener('error', function () {
      if (photo.thumbUrl && img.src !== photo.thumbUrl) {
        img.src = photo.thumbUrl;
      }
    }, { once: true });
    modal.appendChild(img);

    modal.addEventListener('click', function (e) {
      if (e.target === modal) close();
    });

    this._previewEscHandler = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', this._previewEscHandler);

    document.body.appendChild(modal);
  };

  MCWBuilder.prototype.closePreviewModal = function () {
    var modal = qs('#mcw-preview-modal');
    if (modal) modal.remove();
    if (this._previewEscHandler) {
      document.removeEventListener('keydown', this._previewEscHandler);
      this._previewEscHandler = null;
    }
  };

  MCWBuilder.prototype.applyCrop = function (photo) {
    if (!this.cropper) return;

    var self = this;
    var canvas = this.cropper.getCroppedCanvas({
      maxWidth: MAX_DIMENSION,
      maxHeight: MAX_DIMENSION,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high'
    });

    this.closeCropModal();

    // Show uploading state on photo
    photo.status = 'uploading';
    photo.progress = 0;
    this.updatePhotoUI(photo);

    canvas.toBlob(function (blob) {
      if (!blob) {
        photo.status = 'ready'; // revert
        self.updatePhotoUI(photo);
        self.showToast('Crop failed. Please try again.');
        return;
      }

      // Upload cropped image as new file
      self.uploader.getPresignedUrl(self.state.sessionId, 'image/jpeg')
        .then(function (urlData) {
          return self.uploader.uploadToS3(urlData.uploadUrl, blob, function (pct) {
            photo.progress = pct;
            self.updatePhotoProgress(photo);
          }).then(function () {
            // Replace URL with new cropped version
            photo.url = urlData.publicUrl;
            photo.thumbUrl = urlData.publicUrl;
            photo.status = 'ready';
            photo.progress = 1;
            self.updatePhotoUI(photo);
            self.saveSession();
          });
        })
        .catch(function (err) {
          console.error('Crop upload failed:', err);
          photo.status = 'ready'; // revert to old URL
          self.updatePhotoUI(photo);
          self.showToast('Crop upload failed. Your original photo is preserved.');
        });
    }, 'image/jpeg', JPEG_QUALITY);
  };

  /* ── STEP 3: Customize & Upsell ── */
  MCWBuilder.prototype.renderStep3 = function () {
    var self = this;
    var content = this._contentEl;
    content.innerHTML = '';

    content.appendChild(el('span', { className: 'mcw-kicker' }, 'Step 3 · Customize'));
    content.appendChild(el('h2', null, 'Customize your book'));

    // --- Cover Section: two side-by-side choice cards ---
    if (this.state.coverVariantId) {
      var coverSection = el('div', { className: 'mcw-customize-section' });
      coverSection.appendChild(el('h3', { className: 'mcw-customize-title' }, 'Choose your cover'));

      var isCustom = this.state.coverSelected;
      var uploadStatus = this._coverUploadStatus || 'idle';
      var standardCoverUrl = (this.config && this.config.standardCoverUrl) || '';

      var cardsRow = el('div', { className: 'mcw-cover-cards' });

      // --- Standard Cover card ---
      var standardCard = el('div', {
        className: 'mcw-cover-card' + (!isCustom ? ' mcw-cover-card--selected' : ''),
        role: 'button',
        tabindex: '0',
        'aria-pressed': String(!isCustom),
        onClick: function () { self.selectStandardCover(); }
      });
      standardCard.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self.selectStandardCover(); }
      });

      // Header (title + price) renders above the preview so shoppers see the
      // choice label without scrolling the image.
      standardCard.appendChild(el('div', { className: 'mcw-cover-card__body' }, [
        el('div', { className: 'mcw-cover-card__title-row' }, [
          el('div', { className: 'mcw-cover-card__title' }, 'Standard Cover'),
          el('div', { className: 'mcw-cover-card__price mcw-cover-card__price--free' }, 'Included')
        ]),
        el('div', { className: 'mcw-cover-card__sub' }, 'Our signature My Colorful World design')
      ]));

      var standardPreview = el('div', { className: 'mcw-cover-card__preview' });
      if (standardCoverUrl) {
        var stdImg = document.createElement('img');
        stdImg.alt = 'Standard My Colorful World cover';
        stdImg.loading = 'lazy';
        stdImg.src = standardCoverUrl;
        standardPreview.appendChild(stdImg);
      }
      standardPreview.appendChild(el('div', { className: 'mcw-cover-card__check', innerHTML: '&#10003;' }));
      standardCard.appendChild(standardPreview);
      cardsRow.appendChild(standardCard);

      // --- Custom Cover card ---
      var customCard = el('div', {
        className: 'mcw-cover-card mcw-cover-card--custom'
          + (isCustom ? ' mcw-cover-card--selected' : '')
          + (uploadStatus === 'uploading' ? ' mcw-cover-card--uploading' : ''),
        role: 'button',
        tabindex: '0',
        'aria-pressed': String(isCustom),
        onClick: function (e) {
          if (e.target.closest('.mcw-cover-card__change')) return;
          self.selectCustomCover();
        }
      });
      customCard.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self.selectCustomCover(); }
      });

      customCard.appendChild(el('div', { className: 'mcw-cover-card__body' }, [
        el('div', { className: 'mcw-cover-card__title-row' }, [
          el('div', { className: 'mcw-cover-card__title' }, 'Custom Cover'),
          el('div', { className: 'mcw-cover-card__price' }, '+' + formatMoney(self.state.coverPrice))
        ]),
        el('div', { className: 'mcw-cover-card__sub' }, 'Add a photo & message to your cover')
      ]));

      var customPreview = el('div', { className: 'mcw-cover-card__preview mcw-cover-card__preview--custom' });

      if (uploadStatus === 'uploading') {
        customPreview.appendChild(el('div', { className: 'mcw-cover-card__uploading' }, [
          el('div', { className: 'spinner' }),
          el('span', null, 'Uploading…')
        ]));
      } else if (this.state.coverPhotoUrl) {
        var custImg = document.createElement('img');
        custImg.crossOrigin = 'anonymous';
        custImg.alt = 'Your custom cover photo';
        custImg.loading = 'lazy';
        custImg.src = this.state.coverPhotoUrl;
        customPreview.appendChild(custImg);
        customPreview.appendChild(el('button', {
          className: 'mcw-cover-card__change',
          type: 'button',
          onClick: function (e) { e.stopPropagation(); self.openCoverPicker(); }
        }, 'Change photo'));
      } else {
        customPreview.appendChild(el('div', { className: 'mcw-cover-card__upload-prompt' }, [
          el('div', {
            className: 'mcw-cover-card__upload-icon',
            innerHTML: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 15l-5-4-8 7"/><path d="M12 3v4M10 5h4" /></svg>'
          }),
          el('div', { className: 'mcw-cover-card__upload-text' }, 'Upload your cover photo'),
          el('div', { className: 'mcw-cover-card__upload-hint' }, 'JPG, PNG, or HEIC')
        ]));
      }
      customPreview.appendChild(el('div', { className: 'mcw-cover-card__check', innerHTML: '&#10003;' }));
      customCard.appendChild(customPreview);
      cardsRow.appendChild(customCard);

      coverSection.appendChild(cardsRow);

      if (uploadStatus === 'error') {
        coverSection.appendChild(el('div', { className: 'mcw-cover-error' }, [
          el('span', null, this._coverUploadError || 'Upload failed.'),
          el('button', {
            className: 'mcw-cover-error__retry',
            type: 'button',
            onClick: function () { self.openCoverPicker(); }
          }, 'Try again')
        ]));
      }

      // Cover message input — framed as its own block so it reads as a real
      // step, not a footnote. Only appears when custom cover is chosen with a photo.
      if (isCustom && this.state.coverPhotoUrl && uploadStatus !== 'uploading') {
        var messageBox = el('div', { className: 'mcw-cover-message-box', id: 'mcw-cover-message-box' });
        messageBox.appendChild(el('label', {
          className: 'mcw-cover-title-label',
          'for': 'mcw-cover-title-input'
        }, 'Add a message to your cover'));
        messageBox.appendChild(el('div', { className: 'mcw-cover-message-hint' },
          'Optional — up to 100 characters. Appears on the cover under your photo.'));
        var textInput = el('input', {
          id: 'mcw-cover-title-input',
          type: 'text',
          className: 'mcw-cover-text-input',
          placeholder: 'e.g., Happy Birthday, Abuela!',
          value: self.state.coverText || '',
          maxlength: '100'
        });
        textInput.addEventListener('input', function () {
          self.state.coverText = textInput.value;
          self.saveSession();
        });
        messageBox.appendChild(textInput);
        coverSection.appendChild(messageBox);
      }

      content.appendChild(coverSection);
    }

    // --- Book Size Section ---
    // Only render when the product actually has multiple available variants.
    // MCW products are one-per-size (20/32/40 pages), so a single-variant
    // product produces a meaningless "Default Title · $X" row — hide it.
    var availableVariants = this.state.variants.filter(function (v) { return v.available; });
    var photoCount = this.getReadyPhotoCount();
    var currentVariant = this.state.variants.find(function (v) {
      return v.id === self.state.variantId;
    });

    // MCW 2026-05-22: Book Size section suppressed in Step 3.
    // Reason: variant is already selected on the product page via the swatch picker;
    // showing it again in Step 3 is confusing and would require users to backtrack
    // if they want to revise. The +2 photo buffer (max_photos = pageCount + 2) keeps
    // small over-uploads within bounds without triggering the upsell prompt.
    // To re-enable: replace `if (false)` with `if (availableVariants.length > 1)`.
    if (false) {
    var sizeSection = el('div', { className: 'mcw-customize-section' });
    sizeSection.appendChild(el('h3', { className: 'mcw-customize-title' }, 'Book Size'));

    // Show upgrade prompt if photos exceed current max
    if (photoCount > this.state.maxPhotos) {
      var nextVariant = this.findVariantForCount(photoCount);
      if (nextVariant) {
        var delta = nextVariant.price - (currentVariant ? currentVariant.price : 0);
        sizeSection.appendChild(el('div', { className: 'mcw-size-upgrade' }, [
          el('div', { className: 'mcw-size-upgrade-title' },
            'You have ' + photoCount + ' photos but selected a ' + (currentVariant ? currentVariant.title : '') + ' book.'),
          el('p', { style: 'font-size:13px;margin-bottom:8px;' },
            'Upgrade to include all your photos:'),
          el('button', {
            className: 'mcw-btn-primary',
            style: 'font-size:14px;padding:10px 16px;',
            onClick: function () {
              self.switchVariant(nextVariant.id);
            }
          }, 'Upgrade to ' + nextVariant.title + ' (+' + formatMoney(delta) + ')')
        ]));
      }
    }

    // Variant size options
    var sizeOptions = el('div', { className: 'mcw-size-options' });
    this.state.variants.forEach(function (v) {
      if (!v.available) return;
      var isSelected = v.id === self.state.variantId;
      var opt = el('div', {
        className: 'mcw-size-option' + (isSelected ? ' selected' : ''),
        onClick: function () {
          self.switchVariant(v.id);
        }
      }, [
        el('span', { style: 'font-weight:600;' }, v.title),
        el('span', null, formatMoney(v.price))
      ]);
      sizeOptions.appendChild(opt);
    });
    sizeSection.appendChild(sizeOptions);

    // Threshold warning for downgrade
    sizeSection.appendChild(el('div', { id: 'mcw-threshold-msg' }));

    content.appendChild(sizeSection);
    } // end availableVariants.length > 1

    // Update threshold (no-op when size section wasn't rendered)
    this.updateThresholdDisplay();

    // Footer: progress label on left, pink CTA pill on right
    this._footerEl.innerHTML = '';
    var progressEl = el('div', { className: 'mcw-footer-progress', id: 'mcw-footer-progress' });
    var addToCartBtn = el('button', {
      className: 'mcw-btn-primary',
      id: 'mcw-continue-btn',
      onClick: function () { self.goToStep(4); }
    }, ['Review Order ', el('span', { className: 'mcw-btn-arrow', 'aria-hidden': 'true' }, '\u2192')]);
    var backLink = el('button', { className: 'mcw-back-link', style: 'background:none;border:0;padding:8px 6px;color:#004a70;text-decoration:underline;cursor:pointer;font:inherit;font-size:0.95rem;', onClick: function () { self.goToStep(2); } }, ['\u2190 Back']);
    this._footerEl.appendChild(el('div', { className: 'mcw-footer-row' }, [progressEl, el('div', { className: 'mcw-footer-actions', style: 'display:flex;gap:14px;align-items:center;' }, [backLink, addToCartBtn])]));

    // Populate progress label (and baseline disable state)
    this.updateContinueButton();

    // Disable if cover selected but no photo chosen, or while a cover upload is in flight
    var canProceed = photoCount >= this.state.minPhotos && photoCount <= this.state.maxPhotos;
    if (this.state.coverSelected && !this.state.coverPhotoUrl) canProceed = false;
    if (this._coverUploadStatus === 'uploading') canProceed = false;
    addToCartBtn.disabled = !canProceed;
  };

  /* ── Cover selection + upload ── */

  MCWBuilder.prototype.selectStandardCover = function () {
    if (this._coverUploadStatus === 'uploading') return;
    this.state.coverSelected = false;
    this.saveSession();
    this.renderStep3();
  };

  // Custom card click: if no photo yet, prompt for upload; if photo exists, just select.
  MCWBuilder.prototype.selectCustomCover = function () {
    if (this._coverUploadStatus === 'uploading') return;
    if (this.state.coverPhotoUrl) {
      this.state.coverSelected = true;
      this.saveSession();
      this.renderStep3();
    } else {
      this.openCoverPicker();
    }
  };

  MCWBuilder.prototype.openCoverPicker = function () {
    var self = this;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/heic,image/heif,image/webp';
    input.style.display = 'none';
    input.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) self.handleCoverFile(file);
      if (input.parentNode) input.parentNode.removeChild(input);
    });
    document.body.appendChild(input);
    input.click();
  };

  MCWBuilder.prototype.handleCoverFile = function (file) {
    var self = this;
    this._coverUploadStatus = 'uploading';
    this._coverUploadError = '';
    this.renderStep3();

    this.uploader.processAndUpload(
      file,
      this.state.sessionId,
      null,  // onProgress — no per-card progress bar for now
      null   // onStatusChange
    ).then(function (result) {
      self.state.coverPhotoUrl = result.publicUrl;
      self.state.coverSelected = true;
      self._coverUploadStatus = 'idle';
      self.saveSession();
      self.renderStep3();
      // Nudge focus toward the newly-revealed message field so the next action
      // is obvious without the user having to hunt for it.
      requestAnimationFrame(function () {
        var box = document.getElementById('mcw-cover-message-box');
        if (box && typeof box.scrollIntoView === 'function') {
          box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }).catch(function (err) {
      console.error('Cover upload failed', err);
      self._coverUploadStatus = 'error';
      self._coverUploadError = (err && err.message) || 'Upload failed. Please try again.';
      self.renderStep3();
    });
  };

  MCWBuilder.prototype.findVariantForCount = function (count) {
    // Find smallest variant that can fit this photo count
    var sorted = this.state.variants
      .filter(function (v) { return v.available; })
      .sort(function (a, b) {
        var aPages = parseInt(a.title, 10) || 0;
        var bPages = parseInt(b.title, 10) || 0;
        return aPages - bPages;
      });

    for (var i = 0; i < sorted.length; i++) {
      var pages = parseInt(sorted[i].title, 10) || 0;
      if (pages >= count) return sorted[i];
    }
    return sorted[sorted.length - 1]; // largest available
  };

  MCWBuilder.prototype.switchVariant = function (variantId) {
    var variant = this.state.variants.find(function (v) { return v.id === variantId; });
    if (!variant) return;

    this.state.variantId = variant.id;
    this.state.variantTitle = variant.title;
    this.state.bookPrice = variant.price;

    // Update min/max from variant title
    var pageMatch = variant.title.match(/(\d+)/);
    var pageCount = pageMatch ? parseInt(pageMatch[1], 10) : 20;
    this.state.minPhotos = Math.max(1, pageCount - 4);
    this.state.maxPhotos = pageCount;

    // Re-render step 3
    this.renderStep3();
    this.saveSession();
  };

  /* ── STEP 4: Order Summary & Add to Cart ── */
  MCWBuilder.prototype.renderStep4 = function () {
    var self = this;
    var content = this._contentEl;
    content.innerHTML = '';

    var readyPhotos = this.state.photos.filter(function (p) { return p.status === 'ready'; });

    content.appendChild(el('span', { className: 'mcw-kicker' }, 'Step 4 · Review order'));
    content.appendChild(el('h2', null, 'Order summary'));

    // Summary card
    var summary = el('div', { className: 'mcw-order-summary' });

    // Book info
    summary.appendChild(el('div', { className: 'mcw-summary-row' }, [
      el('span', null, this.state.productTitle),
      el('span', { style: 'font-weight:600;' }, formatMoney(this.state.bookPrice))
    ]));
    summary.appendChild(el('div', { className: 'mcw-summary-row' }, [
      el('span', { style: 'color:var(--mcw-gray-600);' }, this.state.variantTitle),
      el('span', { style: 'color:var(--mcw-gray-600);' }, readyPhotos.length + ' photos')
    ]));

    // Photo thumbnails — crossOrigin='anonymous' matches the Step 1/2 pattern so
    // CloudFront always caches with CORS headers (see feedback_mcw_builder_css_reset
    // / crop CORS fix). Using imperative createElement to guarantee order.
    var thumbs = el('div', { className: 'mcw-summary-thumbs' });
    readyPhotos.slice(0, 8).forEach(function (p) {
      var t = document.createElement('img');
      t.className = 'mcw-summary-thumb';
      t.crossOrigin = 'anonymous';
      t.alt = 'Photo';
      t.loading = 'lazy';
      t.src = p.thumbUrl || p.url;
      thumbs.appendChild(t);
    });
    if (readyPhotos.length > 8) {
      thumbs.appendChild(el('span', {
        style: 'display:flex;align-items:center;font-size:12px;color:var(--mcw-gray-600);padding-left:4px;'
      }, '+' + (readyPhotos.length - 8) + ' more'));
    }
    summary.appendChild(thumbs);

    // Custom cover info — thumbnail + label (with optional message) on the left,
    // price on the right, matching how order line items read on Shopify.
    if (this.state.coverSelected && this.state.coverPhotoUrl) {
      var coverThumb = document.createElement('img');
      coverThumb.className = 'mcw-summary-cover-thumb';
      coverThumb.crossOrigin = 'anonymous';
      coverThumb.alt = 'Custom cover preview';
      coverThumb.loading = 'lazy';
      coverThumb.src = this.state.coverPhotoUrl;

      var coverLabel = el('div', { className: 'mcw-summary-cover-label' }, [
        el('div', { style: 'font-weight:600;' }, 'Custom Cover')
      ]);
      if (this.state.coverText) {
        coverLabel.appendChild(el('div', {
          style: 'color:var(--mcw-gray-600);font-style:italic;font-size:13px;margin-top:2px;'
        }, '"' + this.state.coverText + '"'));
      }

      var coverRow = el('div', { className: 'mcw-summary-row mcw-summary-cover-row' });
      var coverLeft = el('div', { className: 'mcw-summary-cover-left' });
      coverLeft.appendChild(coverThumb);
      coverLeft.appendChild(coverLabel);
      coverRow.appendChild(coverLeft);
      coverRow.appendChild(el('span', { style: 'font-weight:600;' }, '+' + formatMoney(this.state.coverPrice)));
      summary.appendChild(coverRow);
    }

    // Total
    var total = this.state.bookPrice + (this.state.coverSelected ? this.state.coverPrice : 0);
    summary.appendChild(el('div', { className: 'mcw-summary-row total' }, [
      el('span', null, 'Total'),
      el('span', null, formatMoney(total))
    ]));

    content.appendChild(summary);

    // Edit links
    var editLinks = el('div', { style: 'margin-top:16px;display:flex;gap:12px;flex-wrap:wrap;' });
    editLinks.appendChild(el('button', {
      className: 'mcw-btn-secondary',
      style: 'flex:1;min-width:140px;',
      onClick: function () { self.goToStep(1); }
    }, 'Edit Photos'));
    editLinks.appendChild(el('button', {
      className: 'mcw-btn-secondary',
      style: 'flex:1;min-width:140px;',
      onClick: function () { self.goToStep(3); }
    }, 'Edit Cover'));
    content.appendChild(editLinks);

    // Footer: Add to Cart / Save Changes (when editing an existing cart line)
    this._footerEl.innerHTML = '';
    var isEditing = !!this.state.editingLineKey;
    var btnLabel = isEditing
      ? 'Save Changes \u2014 ' + formatMoney(total)
      : 'Add to Cart \u2014 ' + formatMoney(total);
    var atcBtn = el('button', {
      className: 'mcw-btn-primary',
      id: 'mcw-atc-btn',
      onClick: function () { self.addToCart(); }
    }, btnLabel);
    this._footerEl.appendChild(atcBtn);
  };

  // Sequentially remove old cart lines by key (used by Save Changes). Shopify's
  // /cart/change.js accepts one key at a time, so we chain the calls.
  MCWBuilder.prototype._removeCartLines = function (keys) {
    var chain = Promise.resolve();
    keys.filter(Boolean).forEach(function (k) {
      chain = chain.then(function () {
        return fetch('/cart/change.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: k, quantity: 0 })
        }).then(function (r) {
          if (!r.ok) throw new Error('Failed to remove cart line ' + k);
        });
      });
    });
    return chain;
  };

  /* ── Add to Cart (WebGarth-compatible bundle schema) ──
     Book line carries Uploaded Pictures N + Choose Cover Photo + Your Personal Message.
     Cover line is a billing sku linked back via _mcw_parent_bundle_id.
     WebGarth reads only book lines (no ghost second book from cover).
     When state.editingLineKey is set, this is a Save-Changes flow: remove the
     old book + cover lines first, then add the replacements, then redirect. */
  MCWBuilder.prototype.addToCart = function () {
    var self = this;
    var btn = qs('#mcw-atc-btn');
    var isEditing = !!this.state.editingLineKey;
    if (btn) {
      btn.disabled = true;
      btn.textContent = isEditing ? 'Saving changes...' : 'Adding to cart...';
    }

    var readyPhotos = this.state.photos
      .filter(function (p) { return p.status === 'ready'; })
      .sort(function (a, b) { return a.order - b.order; });

    var bundleId = generateBundleId();
    var items = [];

    // BOOK line: photos + cover URL + message + bundle link
    var bookProperties = {};
    readyPhotos.forEach(function (photo, index) {
      bookProperties['Uploaded Pictures ' + (index + 1)] = photo.url;
    });
    if (this.state.coverSelected && this.state.coverPhotoUrl) {
      bookProperties['Choose Cover Photo'] = this.state.coverPhotoUrl;
      if (this.state.coverText) {
        bookProperties['Your Personal Message'] = this.state.coverText;
        // Mirror under a "text"-keyed name so WebGarh's filter picks it up.
        // Filter logic: orders.controller.js:221 keeps attrs where the key
        // contains "text" OR the value contains "https://".
        bookProperties['Cover Message Text'] = this.state.coverText;
      }
    }
    bookProperties['_mcw_bundle_id'] = bundleId;
    items.push({
      id: this.state.variantId,
      quantity: 1,
      properties: bookProperties
    });

    // COVER line: billing sku linked back to book (no photos here)
    if (this.state.coverSelected && this.state.coverPhotoUrl && this.state.coverVariantId) {
      items.push({
        id: this.state.coverVariantId,
        quantity: 1,
        properties: {
          '_mcw_parent_bundle_id': bundleId,
          '_mcw_field_name': 'Add Customized Book Cover'
        }
      });
    }

    // Safety check: payload size
    var payload = JSON.stringify({ items: items });
    if (payload.length > CART_PAYLOAD_MAX) {
      console.error('MCW Builder: Cart payload exceeds max!', payload.length, 'bytes');
      this.showError('Something went wrong \u2014 too many photos for cart. Please contact support.');
      if (btn) { btn.disabled = false; btn.textContent = 'Add to Cart'; }
      return;
    }
    if (payload.length > CART_PAYLOAD_WARN) {
      console.warn('MCW Builder: Cart payload approaching limit:', payload.length, 'bytes');
    }

    // When editing, remove the old book + cover lines first. Shopify reassigns
    // line keys on mutation, so we capture them before the remove call.
    var removePromise = isEditing
      ? this._removeCartLines([this.state.editingLineKey, this.state.editingCoverLineKey])
      : Promise.resolve();

    removePromise
      .then(function () {
        return fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload
        });
      })
      .then(function (response) {
        if (!response.ok) {
          return response.json().then(function (err) {
            throw new Error(err.description || 'Failed to add to cart');
          });
        }
        return response.json();
      })
      .then(function () {
        SessionStore.clear(self.state.productHandle);
        if (isEditing) {
          // Save Changes: land the user on /cart to see the updated cart.
          window.location.href = '/cart';
        } else {
          self.showSuccess();
        }
      })
      .catch(function (err) {
        console.error('MCW Builder ATC error:', err);
        self.showError(err.message || 'Failed to add to cart. Please try again.');
        if (btn) {
          btn.disabled = false;
          btn.textContent = isEditing ? 'Save Changes' : 'Add to Cart';
        }
      });
  };

  /* ── Success State ── */
  MCWBuilder.prototype.showSuccess = function () {
    var self = this;
    this._footerEl.innerHTML = '';

    this._contentEl.innerHTML = '';
    this._contentEl.appendChild(el('div', { className: 'mcw-success' }, [
      el('div', { className: 'mcw-success-icon' }, '\ud83c\udf89'),
      el('h2', { className: 'mcw-success-title' }, 'Added to Cart!'),
      el('p', { className: 'mcw-success-text' },
        'Your personalized coloring book is ready. Head to checkout or create another masterpiece!'),
      el('div', { className: 'mcw-success-actions' }, [
        el('a', {
          className: 'mcw-btn-primary',
          href: this.config.cartUrl || '/cart'
        }, 'View Cart'),
        el('a', {
          className: 'mcw-btn-secondary',
          href: this.config.builderPageUrl || '/pages/create-your-book'
        }, 'Create Another Book')
      ])
    ]));
  };

  /* ── Toast & Error ── */
  MCWBuilder.prototype.showToast = function (message) {
    var existing = qs('.mcw-toast');
    if (existing) existing.remove();

    var toast = el('div', { className: 'mcw-toast' }, [
      el('span', null, message)
    ]);
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 3000);
  };

  MCWBuilder.prototype.showUndoToast = function (message, undoFn) {
    var self = this;
    var existing = qs('.mcw-toast');
    if (existing) existing.remove();

    if (this._undoTimer) clearTimeout(this._undoTimer);

    var toast = el('div', { className: 'mcw-toast' }, [
      el('span', null, message),
      el('button', {
        onClick: function () {
          clearTimeout(self._undoTimer);
          toast.remove();
          if (undoFn) undoFn();
        }
      }, 'Undo')
    ]);
    document.body.appendChild(toast);

    this._undoTimer = setTimeout(function () {
      toast.remove();
    }, UNDO_TIMEOUT);
  };

  MCWBuilder.prototype.showError = function (message) {
    // Try to insert into error banner area
    var banner = qs('#mcw-error-banner');
    if (banner) {
      banner.innerHTML = '';
      banner.appendChild(el('div', { className: 'mcw-error-banner' }, [
        el('span', null, '\u26a0'),
        el('span', null, message)
      ]));
      return;
    }

    // Fallback: render full error page
    this.root.innerHTML = '';
    this.root.appendChild(el('div', { className: 'mcw-builder' }, [
      el('div', { style: 'padding:48px 24px;text-align:center;' }, [
        el('div', { className: 'mcw-error-banner', style: 'display:inline-flex;max-width:480px;' }, [
          el('span', null, '\u26a0'),
          el('span', null, message)
        ]),
        el('a', {
          className: 'mcw-btn-secondary',
          style: 'display:inline-block;margin-top:20px;max-width:240px;',
          href: '/'
        }, 'Back to Shop')
      ])
    ]));
  };

  /* ── Init on DOM ready ── */
  document.addEventListener('DOMContentLoaded', function () {
    var root = qs('#mcw-builder-app') || qs('[data-builder-root]');
    if (root) {
      window.MCWBuilderInstance = new MCWBuilder(root);
    }
  });

})();
