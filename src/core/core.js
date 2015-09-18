/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals warn, Dict, isDict, shadow, isArray, Util, StreamsSequenceStream,
           isStream, NullStream, ObjectLoader, PartialEvaluator, Promise,
           OperatorList, Annotation, error, assert, XRef, isArrayBuffer, Stream,
           isString, isName, info, Linearization, MissingDataException, Lexer,
           Catalog, stringToPDFString, stringToBytes, calculateMD5,
           AnnotationFactory, SignatureDict, WidgetAnnotation, RawObject,
           Name, Ref, createPromiseCapability, HexEncode, BoundingBox */

'use strict';

var Page = (function PageClosure() {

  var LETTER_SIZE_MEDIABOX = [0, 0, 612, 792];

  function Page(pdfManager, xref, pageIndex, pageDict, ref, fontCache) {
    this.pdfManager = pdfManager;
    this.pageIndex = pageIndex;
    this.pageDict = pageDict;
    this.xref = xref;
    this.ref = ref;
    this.fontCache = fontCache;
    this.idCounters = {
      obj: 0
    };
    this.resourcesPromise = null;
  }

  Page.prototype = {
    getPageProp: function Page_getPageProp(key) {
      return this.pageDict.get(key);
    },

    getInheritedPageProp: function Page_getInheritedPageProp(key) {
      var dict = this.pageDict, valueArray = null, loopCount = 0;
      var MAX_LOOP_COUNT = 100;
      // Always walk up the entire parent chain, to be able to find
      // e.g. \Resources placed on multiple levels of the tree.
      while (dict) {
        var value = dict.get(key);
        if (value) {
          if (!valueArray) {
            valueArray = [];
          }
          valueArray.push(value);
        }
        if (++loopCount > MAX_LOOP_COUNT) {
          warn('Page_getInheritedPageProp: maximum loop count exceeded.');
          break;
        }
        dict = dict.get('Parent');
      }
      if (!valueArray) {
        return Dict.empty;
      }
      if (valueArray.length === 1 || !isDict(valueArray[0]) ||
          loopCount > MAX_LOOP_COUNT) {
        return valueArray[0];
      }
      return Dict.merge(this.xref, valueArray);
    },

    get content() {
      return this.getPageProp('Contents');
    },

    get resources() {
      // For robustness: The spec states that a \Resources entry has to be
      // present, but can be empty. Some document omit it still, in this case
      // we return an empty dictionary.
      return shadow(this, 'resources', this.getInheritedPageProp('Resources'));
    },

    get mediaBox() {
      var obj = this.getInheritedPageProp('MediaBox');
      // Reset invalid media box to letter size.
      if (!isArray(obj) || obj.length !== 4) {
        obj = LETTER_SIZE_MEDIABOX;
      }
      return shadow(this, 'mediaBox', obj);
    },

    get view() {
      var mediaBox = this.mediaBox;
      var cropBox = this.getInheritedPageProp('CropBox');
      if (!isArray(cropBox) || cropBox.length !== 4) {
        return shadow(this, 'view', mediaBox);
      }

      // From the spec, 6th ed., p.963:
      // "The crop, bleed, trim, and art boxes should not ordinarily
      // extend beyond the boundaries of the media box. If they do, they are
      // effectively reduced to their intersection with the media box."
      cropBox = Util.intersect(cropBox, mediaBox);
      if (!cropBox) {
        return shadow(this, 'view', mediaBox);
      }
      return shadow(this, 'view', cropBox);
    },

    get rotate() {
      var rotate = this.getInheritedPageProp('Rotate') || 0;
      // Normalize rotation so it's a multiple of 90 and between 0 and 270
      if (rotate % 90 !== 0) {
        rotate = 0;
      } else if (rotate >= 360) {
        rotate = rotate % 360;
      } else if (rotate < 0) {
        // The spec doesn't cover negatives, assume its counterclockwise
        // rotation. The following is the other implementation of modulo.
        rotate = ((rotate % 360) + 360) % 360;
      }
      return shadow(this, 'rotate', rotate);
    },

    getContentStream: function Page_getContentStream() {
      var content = this.content;
      var stream;
      if (isArray(content)) {
        // fetching items
        var xref = this.xref;
        var i, n = content.length;
        var streams = [];
        for (i = 0; i < n; ++i) {
          streams.push(xref.fetchIfRef(content[i]));
        }
        stream = new StreamsSequenceStream(streams);
      } else if (isStream(content)) {
        stream = content;
      } else {
        // replacing non-existent page content with empty one
        stream = new NullStream();
      }
      return stream;
    },

    loadResources: function Page_loadResources(keys) {
      if (!this.resourcesPromise) {
        // TODO: add async getInheritedPageProp and remove this.
        this.resourcesPromise = this.pdfManager.ensure(this, 'resources');
      }
      return this.resourcesPromise.then(function resourceSuccess() {
        var objectLoader = new ObjectLoader(this.resources.map,
                                            keys,
                                            this.xref);
        return objectLoader.load();
      }.bind(this));
    },

    getOperatorList: function Page_getOperatorList(handler, intent) {
      var self = this;

      var pdfManager = this.pdfManager;
      var contentStreamPromise = pdfManager.ensure(this, 'getContentStream',
                                                   []);
      var resourcesPromise = this.loadResources([
        'ExtGState',
        'ColorSpace',
        'Pattern',
        'Shading',
        'XObject',
        'Font'
        // ProcSet
        // Properties
      ]);

      var partialEvaluator = new PartialEvaluator(pdfManager, this.xref,
                                                  handler, this.pageIndex,
                                                  'p' + this.pageIndex + '_',
                                                  this.idCounters,
                                                  this.fontCache);

      var dataPromises = Promise.all([contentStreamPromise, resourcesPromise]);
      var pageListPromise = dataPromises.then(function(data) {
        var contentStream = data[0];
        var opList = new OperatorList(intent, handler, self.pageIndex);

        handler.send('StartRenderPage', {
          transparency: partialEvaluator.hasBlendModes(self.resources),
          pageIndex: self.pageIndex,
          intent: intent
        });
        return partialEvaluator.getOperatorList(contentStream, self.resources,
          opList).then(function () {
            return opList;
          });
      });

      var annotationsPromise = pdfManager.ensure(this, 'annotations');
      return Promise.all([pageListPromise, annotationsPromise]).then(
          function(datas) {
        var pageOpList = datas[0];
        var annotations = datas[1];

        if (annotations.length === 0) {
          pageOpList.flush(true);
          return pageOpList;
        }

        var annotationsReadyPromise = Annotation.appendToOperatorList(
          annotations, pageOpList, pdfManager, partialEvaluator, intent);
        return annotationsReadyPromise.then(function () {
          pageOpList.flush(true);
          return pageOpList;
        });
      });
    },

    extractTextContent: function Page_extractTextContent() {
      var handler = {
        on: function nullHandlerOn() {},
        send: function nullHandlerSend() {}
      };

      var self = this;

      var pdfManager = this.pdfManager;
      var contentStreamPromise = pdfManager.ensure(this, 'getContentStream',
                                                   []);

      var resourcesPromise = this.loadResources([
        'ExtGState',
        'XObject',
        'Font'
      ]);

      var dataPromises = Promise.all([contentStreamPromise,
                                      resourcesPromise]);
      return dataPromises.then(function(data) {
        var contentStream = data[0];
        var partialEvaluator = new PartialEvaluator(pdfManager, self.xref,
                                                    handler, self.pageIndex,
                                                    'p' + self.pageIndex + '_',
                                                    self.idCounters,
                                                    self.fontCache);

        return partialEvaluator.getTextContent(contentStream,
                                               self.resources);
      });
    },

    getAnnotationsData: function Page_getAnnotationsData() {
      var annotations = this.annotations;
      var annotationsData = [];
      for (var i = 0, n = annotations.length; i < n; ++i) {
        annotationsData.push(annotations[i].data);
      }
      return annotationsData;
    },

    get annotations() {
      var annotations = [];
      var annotationRefs = this.getInheritedPageProp('Annots') || [];
      var annotationFactory = new AnnotationFactory();
      for (var i = 0, n = annotationRefs.length; i < n; ++i) {
        var annotationRef = annotationRefs[i];
        var annotation = annotationFactory.create(this.xref, annotationRef);
        if (annotation &&
            (annotation.isViewable() || annotation.isPrintable())) {
          annotations.push(annotation);
        }
      }
      return shadow(this, 'annotations', annotations);
    }
  };

  return Page;
})();

/**
 * The `PDFDocument` holds all the data of the PDF file. Compared to the
 * `PDFDoc`, this one doesn't have any job management code.
 * Right now there exists one PDFDocument on the main thread + one object
 * for each worker. If there is no worker support enabled, there are two
 * `PDFDocument` objects on the main thread created.
 */
var PDFDocument = (function PDFDocumentClosure() {
  var FINGERPRINT_FIRST_BYTES = 1024;
  var EMPTY_FINGERPRINT = '\x00\x00\x00\x00\x00\x00\x00' +
    '\x00\x00\x00\x00\x00\x00\x00\x00\x00';

  function PDFDocument(pdfManager, arg, password) {
    if (isStream(arg)) {
      init.call(this, pdfManager, arg, password);
    } else if (isArrayBuffer(arg)) {
      init.call(this, pdfManager, new Stream(arg), password);
    } else {
      error('PDFDocument: Unknown argument type');
    }
  }

  function init(pdfManager, stream, password) {
    assert(stream.length > 0, 'stream must have data');
    this.pdfManager = pdfManager;
    this.stream = stream;
    var xref = new XRef(this.stream, password, pdfManager);
    this.xref = xref;
  }

  function find(stream, needle, limit, backwards) {
    var pos = stream.pos;
    var end = stream.end;
    var strBuf = [];
    if (pos + limit > end) {
      limit = end - pos;
    }
    for (var n = 0; n < limit; ++n) {
      strBuf.push(String.fromCharCode(stream.getByte()));
    }
    var str = strBuf.join('');
    stream.pos = pos;
    var index = backwards ? str.lastIndexOf(needle) : str.indexOf(needle);
    if (index === -1) {
      return false; /* not found */
    }
    stream.pos += index;
    return true; /* found */
  }

  var DocumentInfoValidators = {
    get entries() {
      // Lazily build this since all the validation functions below are not
      // defined until after this file loads.
      return shadow(this, 'entries', {
        Title: isString,
        Author: isString,
        Subject: isString,
        Keywords: isString,
        Creator: isString,
        Producer: isString,
        CreationDate: isString,
        ModDate: isString,
        Trapped: isName
      });
    }
  };

  PDFDocument.prototype = {
    parse: function PDFDocument_parse(recoveryMode) {
      this.setup(recoveryMode);
      var version = this.catalog.catDict.get('Version');
      if (isName(version)) {
        this.pdfFormatVersion = version.name;
      }
      try {
        // checking if AcroForm is present
        this.acroForm = this.catalog.catDict.get('AcroForm');
        if (this.acroForm) {
          this.xfa = this.acroForm.get('XFA');
          var fields = this.acroForm.get('Fields');
          if ((!fields || !isArray(fields) || fields.length === 0) &&
              !this.xfa) {
            // no fields and no XFA -- not a form (?)
            this.acroForm = null;
          }
        }
      } catch (ex) {
        info('Something wrong with AcroForm entry');
        this.acroForm = null;
      }
    },

    get linearization() {
      var linearization = null;
      if (this.stream.length) {
        try {
          linearization = Linearization.create(this.stream);
        } catch (err) {
          if (err instanceof MissingDataException) {
            throw err;
          }
          info(err);
        }
      }
      // shadow the prototype getter with a data property
      return shadow(this, 'linearization', linearization);
    },
    get startXRef() {
      var stream = this.stream;
      var startXRef = 0;
      var linearization = this.linearization;
      if (linearization) {
        // Find end of first obj.
        stream.reset();
        if (find(stream, 'endobj', 1024)) {
          startXRef = stream.pos + 6;
        }
      } else {
        // Find startxref by jumping backward from the end of the file.
        var step = 1024;
        var found = false, pos = stream.end;
        while (!found && pos > 0) {
          pos -= step - 'startxref'.length;
          if (pos < 0) {
            pos = 0;
          }
          stream.pos = pos;
          found = find(stream, 'startxref', step, true);
        }
        if (found) {
          stream.skip(9);
          var ch;
          do {
            ch = stream.getByte();
          } while (Lexer.isSpace(ch));
          var str = '';
          while (ch >= 0x20 && ch <= 0x39) { // < '9'
            str += String.fromCharCode(ch);
            ch = stream.getByte();
          }
          startXRef = parseInt(str, 10);
          if (isNaN(startXRef)) {
            startXRef = 0;
          }
        }
      }
      // shadow the prototype getter with a data property
      return shadow(this, 'startXRef', startXRef);
    },
    get mainXRefEntriesOffset() {
      var mainXRefEntriesOffset = 0;
      var linearization = this.linearization;
      if (linearization) {
        mainXRefEntriesOffset = linearization.mainXRefEntriesOffset;
      }
      // shadow the prototype getter with a data property
      return shadow(this, 'mainXRefEntriesOffset', mainXRefEntriesOffset);
    },
    // Find the header, remove leading garbage and setup the stream
    // starting from the header.
    checkHeader: function PDFDocument_checkHeader() {
      var stream = this.stream;
      stream.reset();
      if (find(stream, '%PDF-', 1024)) {
        // Found the header, trim off any garbage before it.
        stream.moveStart();
        // Reading file format version
        var MAX_VERSION_LENGTH = 12;
        var version = '', ch;
        while ((ch = stream.getByte()) > 0x20) { // SPACE
          if (version.length >= MAX_VERSION_LENGTH) {
            break;
          }
          version += String.fromCharCode(ch);
        }
        if (!this.pdfFormatVersion) {
          // removing "%PDF-"-prefix
          this.pdfFormatVersion = version.substring(5);
        }
        return;
      }
      // May not be a PDF file, continue anyway.
    },
    parseStartXRef: function PDFDocument_parseStartXRef() {
      var startXRef = this.startXRef;
      this.xref.setStartXRef(startXRef);
    },
    setup: function PDFDocument_setup(recoveryMode) {
      this.xref.parse(recoveryMode);
      this.catalog = new Catalog(this.pdfManager, this.xref);
      this.incremental = {
        update: XRef.createIncrementalUpdate(this.xref),
        entries: []
      }
    },
    addIncrementalEntry: function(entry, ref) {
      if (!ref) {
        ref = new Ref(this.incremental.update.incremental.startNumber ++, 0); 
      }
      this.incremental.entries.push({
        entry: entry, 
        ref: ref
      });
      return ref;
    },
    get numPages() {
      var linearization = this.linearization;
      var num = linearization ? linearization.numPages : this.catalog.numPages;
      // shadow the prototype getter
      return shadow(this, 'numPages', num);
    },
    get documentInfo() {
      var docInfo = {
        PDFFormatVersion: this.pdfFormatVersion,
        IsAcroFormPresent: !!this.acroForm,
        IsXFAPresent: !!this.xfa
      };
      var infoDict;
      try {
        infoDict = this.xref.trailer.get('Info');
      } catch (err) {
        info('The document information dictionary is invalid.');
      }
      if (infoDict) {
        var validEntries = DocumentInfoValidators.entries;
        // Only fill the document info with valid entries from the spec.
        for (var key in validEntries) {
          if (infoDict.has(key)) {
            var value = infoDict.get(key);
            // Make sure the value conforms to the spec.
            if (validEntries[key](value)) {
              docInfo[key] = (typeof value !== 'string' ?
                              value : stringToPDFString(value));
            } else {
              info('Bad value in document info for "' + key + '"');
            }
          }
        }
      }
      return shadow(this, 'documentInfo', docInfo);
    },
    get fingerprint() {
      var xref = this.xref, idArray, hash, fileID = '';

      if (xref.trailer.has('ID')) {
        idArray = xref.trailer.get('ID');
      }
      if (idArray && isArray(idArray) && idArray[0] !== EMPTY_FINGERPRINT) {
        hash = stringToBytes(idArray[0]);
      } else {
        if (this.stream.ensureRange) {
          this.stream.ensureRange(0,
            Math.min(FINGERPRINT_FIRST_BYTES, this.stream.end));
        }
        hash = calculateMD5(this.stream.bytes.subarray(0,
          FINGERPRINT_FIRST_BYTES), 0, FINGERPRINT_FIRST_BYTES);
      }

      for (var i = 0, n = hash.length; i < n; i++) {
        var hex = hash[i].toString(16);
        fileID += hex.length === 1 ? '0' + hex : hex;
      }

      return shadow(this, 'fingerprint', fileID);
    },

    getPage: function PDFDocument_getPage(pageIndex) {
      return this.catalog.getPage(pageIndex);
    },

    cleanup: function PDFDocument_cleanup() {
      return this.catalog.cleanup();
    },

    addSignature: function PDFDocument_addSignature(signature, signedDataSize) {
      var pageNumber = signature.page || 0;
      var incXref = this.incremental.update.incremental;
      var oldAcroForm = this.acroForm;
      var acroForm = incXref.root.get('AcroForm');
      var doc = this;
      var catalog = this.catalog;
      var catalogRef;
      var xref = this.xref;

      var addSignatureCapability = createPromiseCapability();
      this.getPage(pageNumber).then(function(page) {
        var acroFormRef = copyAcroForm();
        addToPage(acroFormRef, page);
        addSignatureCapability.resolve();
      });

      var copyAcroForm = function() {
        var ref = undefined;
        catalogRef = new Ref(parseInt(xref.root.objId, 0));
        if (oldAcroForm) {
          ref = oldAcroForm.ref;
          for (var i in oldAcroForm.map) {
            acroForm.set(i, oldAcroForm.map[i]);
          }
          ref = doc.addIncrementalEntry(acroForm, ref);
        } else {
          ref = doc.addIncrementalEntry(acroForm, ref);
          catalog.catDict.set('AcroForm', ref);
          doc.addIncrementalEntry(catalog.catDict, catalogRef);
        }

        acroForm.set('SigFlags', 3);
        return ref;
      }

      var addToPage = function(acroFormRef, page) {
        doc.signatureDict = new SignatureDict(incXref, signature, signedDataSize);
        doc.signatureDict.calculateByteRange();
        doc.signatureRef = doc.addIncrementalEntry(doc.signatureDict);

        var fields = acroForm.get('Fields') || [];
        if (signature.isVisual) {
          // todo
        } else {
          var appearance = new Dict(incXref);
          appearance.set('FT', new Name('XObject'));
          appearance.set('SubType', new Name('Form'));
          appearance.set('BBox', new BoundingBox([0.0, 0.0, 2.0, 2.0]));
          var appearanceRef = doc.addIncrementalEntry(appearance);
          var normalAppearance = new Dict(incXref);
          normalAppearance.set('N', appearanceRef);

          var signatureField = new Dict(incXref);
          signatureField.set('FT', new Name('Sig'));
          signatureField.set('Type', new Name('Annot'));
          signatureField.set('SubType', new Name('Widget'));
          signatureField.set('T', 'Signature');
          signatureField.set('F', 132); // Printable and Locked
          signatureField.set('P', page.ref); // page
          signatureField.set('AP', normalAppearance); // appearance
          signatureField.set('V', doc.signatureRef);
          signatureField.set('Rect', new BoundingBox([0, 0, 0, 0]));
          var signatureFieldRef = doc.addIncrementalEntry(signatureField);
          fields.push(signatureFieldRef);
        }
        acroForm.set('SigFlags', 3);
        acroForm.set('Fields', fields);

        var annots = page.pageDict.map['Annots'];
        var annotsDict;
        if (annots) {
          // annots is available within the page
          // so we just need to append to it

        } else {
          // create a new Annots entry
          var annotsArray = [ signatureFieldRef ];
          page.pageDict.set('Annots', annotsArray);
        }
        doc.addIncrementalEntry(page.pageDict, page.ref);
      }
      return addSignatureCapability.promise;
    },

    // The first part of saveIncremental 
    // This function calculates hash of the data to be signed
    saveIncrementalCreateHash: function PDFDocument_saveIncremental() {
      var saveIncrementalCapability = createPromiseCapability();
      var offset = this.stream.end;
      var entries = this.incremental.entries;
      var root = this.xref.trailer.get('Root').objId;
      var prev = 0;
      var doc = this;
      
      var i = offset - 1;
      var count = 0;
      var found = -1;

      // try to get the 'Prev' value
      // start by finding the startxref by going backwards
      while (i > 0) {
        // find the first 'f'
        if (this.stream.bytes[i] === 0x66) {
          found = i; 
          break;
        }
        i--; count ++;
        if (count > 50) break;
      }
      if (found > 0) {
        var prevStr = '';
        i = found + 1;
        // go forward and get concat all the numbers
        while (i < offset) {
          if (this.stream.bytes[i]  === 0x0a) {
            if (prevStr !== '') { 
              break;
            }
          }

          // The byte is a digit
          if (this.stream.bytes[i] >= 0x30) {
            // get the ordinal number
            var diff = this.stream.bytes[i] - 0x30;
            // append to a string
            prevStr += diff;
          }
          i ++;
        }
        // Got the number
        prev = parseInt(prevStr);
      }

      var data = '\n';
      offset += 1;
      var ref = [];
      var refMap = {};
      var byteRange = [0, 0, 0, 0];
      var signatureOffset = 0;

      // prepare a ref map containing offset and real data
      for (var i = 0; i < entries.length; i ++) {
        var key = entries[i].ref.num;
        
        var opening = key + ' 0 obj\n';
        data += opening;
        var raw = entries[i].entry.toRaw();
        // concat the raw string
        data += raw;

        // check whether this is the signatureDict
        if (this.signatureRef && 
            key === this.signatureRef.num &&
            entries[i].ref.gen === this.signatureRef.gen) {

          signatureOffset = offset + opening.length;
        }

        // keep the data in the map
        refMap[key] = {
          entry: entries[i].entry,
          ref: entries[i].ref,
          offset: offset
        }
        // collect the ref number
        ref.push(entries[i].ref.num);

        var ending = 'endobj\n';
        data += ending;
        // calculate offset
        offset += raw.length + 
                  ending.length + 
                  opening.length;
      }
      // Prepend the free entry
      ref.push(0);
      // sort the ref number
      ref = ref.sort();
      var xrefList = [];
      var pos = 0;

      var last = 0;
      var length = 1;
      var start = 0;
      for (var i = 0; i < ref.length; i ++) {
        // if this is the first entry or the diff from previous ref num is not 1
        // then create a new xref record
        if (i !== 0 && ref[i] - last !== 1) {
          pos ++;
          length = 1;
          start = ref[i];
        } 

        var key = ref[i];
        var entry = refMap[key];

        if (i == 0) {
          // populate xref table
          // starting with opening free entry
          xrefList[pos] = {
            start: 0,
            length: length++,
            entries: ['0000000000 65535 f ']
          };
          last = 0;
          continue;
        } 

        xrefList[pos] = xrefList[pos] || {};
        xrefList[pos].entries = xrefList[pos].entries || [];

        // format the offset to 10 digits
        var s = "000000000" + entry.offset;
        var o = s.substr(s.length - 10);

        // record the entries in the table
        xrefList[pos].entries.push(o + ' 00000 n ');
        // update the table length
        xrefList[pos].length = length++;
        xrefList[pos].start = start;
        last = key;
      }

      data += 'xref\r\n';
      // visit the table again so we can get the raw string 
      for (var i = 0; i < xrefList.length; i ++) {
        var entry = xrefList[i]; 

        // collect the opening number
        data += entry.start + ' ' + entry.length + '\n';
        // and then each entry in the table
        for (var j = 0; j < entry.entries.length; j ++) {
          data += entry.entries[j] + '\n';
        }
      }

      var trailer = new Dict(this.xref);
      trailer.set('Prev', prev); 
      trailer.set('Root', new Ref(parseInt(root), 0)); 
      trailer.set('Size', this.incremental.update.incremental.startNumber); 
      data += 'trailer\r\n';
      data += trailer.toRaw() + '\r\n';
      data += 'startxref\r\n' + offset + '\r\n%%EOF\r\n';

      var dataLength = data.length + this.stream.bytes.byteLength;
      if (this.signatureDict) {
        // calculate byte range gap needed to get the hash
        var signatureByteRange = this.signatureDict.calculateByteRange();
        var length = this.signatureDict.toRaw().length;
        byteRange[0] = 0;
        byteRange[1] = signatureOffset + signatureByteRange[1];
        byteRange[2] = signatureOffset + signatureByteRange[2];
        byteRange[3] = dataLength - byteRange[2];

        // Prepare the byteRange to be injected in the SignatureDict
        var byteRangeStr = byteRange.join(' ') + ']';

        var position = this.signatureDict.calculateByteRangePosition();
        var start = signatureOffset - this.stream.end + position[0];
        var end =  start + position[1]; 

        var j = 0;
        var i = start;
        var replacement = '';
        while (i < end) {
          if (typeof(byteRangeStr[j]) !== 'undefined') {
            replacement += byteRangeStr[j];

          } else {
            replacement += ' ';
          }
          i ++;j ++;
        }
        // Replace the byte range in the SignatureDict with the range calculated above
        data = data.substr(0, start) + replacement + ' ' + data.substr(start + replacement.length + 1);
      }

      // Prepare the data in uint8array format
      // This is the complete incremental data
      var uint = new Uint8Array(data.length);
      for (var i = 0, j = data.length; i < j; ++i){
          uint[i] = data.charCodeAt(i);
      }
       
      // Prepare the data to be hashed
      // This is the incremental data plus the original data but without the signed data
      var update = new Uint8Array(this.stream.bytes.byteLength + uint.byteLength);
      update.set(new Uint8Array(this.stream.bytes), 0);
      update.set(new Uint8Array(uint), this.stream.bytes.byteLength);

      uint = null;
      this.incrementalUpdate = {
        data: update,
        byteRange: byteRange
      }

      // concat the data separated by the signed data gap
      var contiguousData = data.substr(0, byteRange[1] - this.stream.end) + 
                          data.substr(byteRange[2] - this.stream.end);

      // and create a uint8array representation
      uint = new Uint8Array(contiguousData.length);
      for (var i = 0, j = contiguousData.length; i < j; ++i){
          uint[i] = contiguousData.charCodeAt(i);
      }
 
      data = null;
      // then concat the original data plus the contiguous data
      var hashData = new Uint8Array(this.stream.end + contiguousData.length);
      hashData.set(new Uint8Array(this.stream.bytes), 0);
      hashData.set(new Uint8Array(uint), this.stream.end);

      // put the contiguous data to the structure and pass it to the worker
      doc.incrementalUpdate.hashData = hashData;

      // go back to the worker now
      saveIncrementalCapability.resolve();

      return saveIncrementalCapability.promise;
    },

    // This is the second part of saveIncremental
    // This function takes the signed data from the client (coming from the worker) 
    // and inject it in the signature dict
    // within pdf prepared in the previous step
    saveIncrementalGetData: function PDFDocument_saveIncremental(signedData) {
      var saveIncrementalCapability = createPromiseCapability();
      var byteRange = this.incrementalUpdate.byteRange;

      try {
      this.incrementalUpdate.data.set((new HexEncode(signedData)).toUint8Array(), byteRange[1]);
      } catch (e) {
      console.log(e.stack);
      }
      
      saveIncrementalCapability.resolve();
      return saveIncrementalCapability.promise;
    }
  };

  return PDFDocument;
})();
