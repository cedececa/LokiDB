import {LokiEventEmitter} from "./event_emitter";
import {UniqueIndex} from "./unique_index";
import {ResultSet, LokiOps} from "./result_set";
import {DynamicView} from "./dynamic_view";
import {ltHelper, gtHelper, aeqHelper} from "./helper";
import {clone, CloneMethod} from "./clone";
import {Doc, Dict} from "../../common/types";
import {FullTextSearch} from "../../full-text-search/src/full_text_search";
import {PLUGINS} from "../../common/plugin";
import {Analyzer} from "../../full-text-search/src/analyzer/analyzer";
import {Serialization} from "./serialization/serialization";

export {CloneMethod} from "./clone";

function average(array: number[]): number {
  return (array.reduce((a, b) => a + b, 0)) / array.length;
}

function standardDeviation(values: number[]): number {
  const avg = average(values);
  const squareDiffs = values.map((value) => {
    const diff = value - avg;
    return diff * diff;
  });

  const avgSquareDiff = average(squareDiffs);
  return Math.sqrt(avgSquareDiff);
}

/**
 * Returns an array with the value of a nested property of an object.
 * Returns an array of values if the nested property is across child arrays.
 * @param {object} obj - the object
 * @param {string[]} path - the path of the nested property
 * @param {any[]} array - the result array
 * @param {number} pathIdx - the current path idx
 * @returns {boolean} true if nested property is across child arrays, otherwise false
 */
function getNestedPropertyValue(obj: object, path: string[], array: any[], pathIdx: number = 0): boolean {
  if (obj === undefined) {
    return false;
  }

  if (pathIdx + 1 === path.length) {
    array.push(obj[path[pathIdx]]);
    return false;
  }

  const curr = obj[path[pathIdx]];
  if (Array.isArray(curr)) {
    for (let i = 0; i < curr.length; i++) {
      getNestedPropertyValue(curr[i], path, array, pathIdx + 1);
    }
    return true;
  } else {
    return getNestedPropertyValue(curr, path, array, pathIdx + 1);
  }
}

/**
 * Collection class that handles documents of same type
 * @extends LokiEventEmitter
 * @param <TData> - the data type
 * @param <TNested> - nested properties of data type
 */
export class Collection<TData extends object = object, TNested extends object = object> extends LokiEventEmitter {
  // the name of the collection
  public name: string;
  // the data held by the collection
  public _data: Doc<TData & TNested>[] = [];
  // index of id
  private _idIndex: number[] = [];
  // user defined indexes
  public _binaryIndices: { [P in keyof (TData & TNested)]?: Collection.BinaryIndex } = {}; // user defined indexes

  /**
   * Unique constraints contain duplicate object references, so they are not persisted.
   * We will keep track of properties which have unique constraints applied here, and regenerate on load.
   */
  public _constraints: {
    unique: {
      [P in keyof (TData & TNested)]?: UniqueIndex<TData & TNested>;
    }
  } = {unique: {}};

  /**
   * Transforms will be used to store frequently used query chains as a series of steps which itself can be stored along
   * with the database.
   */
  public _transforms: Dict<Collection.Transform<TData, TNested>[]> = {};

  /**
   * In autosave scenarios we will use collection level dirty flags to determine whether save is needed.
   * currently, if any collection is dirty we will autosave the whole database if autosave is configured.
   * Defaulting to true since this is called from addCollection and adding a collection should trigger save.
   */
  public _dirty: boolean = true;

  // private holder for cached data
  private _cached: {
    index: number[];
    data: Doc<TData & TNested>[];
    binaryIndex: { [P in keyof (TData & TNested)]?: Collection.BinaryIndex };
  } = null;

  /**
   * If set to true we will optimally keep indices 'fresh' during insert/update/remove ops (never dirty/never needs rebuild).
   * If you frequently intersperse insert/update/remove ops between find ops this will likely be significantly faster option.
   */
  public _adaptiveBinaryIndices: boolean;

  /**
   * Is collection transactional.
   */
  private _transactional: boolean;

  /**
   * Options to clone objects when inserting them.
   */
  public _cloneObjects: boolean;

  /**
   * Default clone method (if enabled) is parse-stringify.
   */
  public _cloneMethod: CloneMethod;

  /**
   * If set to true we will not maintain a meta property for a document.
   */
  private _disableMeta: boolean;

  /**
   * Disable track changes.
   */
  private _disableChangesApi: boolean;

  /**
   * Disable delta update object style on changes.
   */
  public _disableDeltaChangesApi: boolean;

  /**
   * By default, if you insert a document into a collection with binary indices, if those indexed properties contain
   * a DateTime we will convert to epoch time format so that (across serializations) its value position will be the
   * same 'after' serialization as it was 'before'.
   */
  private _serializableIndices: boolean;

  /**
   * Name of path of used nested properties.
   */
  private _nestedProperties: { name: keyof TNested, path: string[] }[] = [];

  /**
   * Option to activate a cleaner daemon - clears "aged" documents at set intervals.
   */
  public _ttl: Collection.TTL = {
    age: null,
    interval: null,
    daemon: null
  };

  // currentMaxId - change manually at your own peril!
  private _maxId: number = 0;
  private _dynamicViews: DynamicView<TData, TNested>[] = [];

  /**
   * Changes are tracked by collection and aggregated by the db.
   */
  private _changes: Collection.Change[] = [];

  /**
   * stages: a map of uniquely identified 'stages', which hold copies of objects to be
   * manipulated without affecting the data in the original collection
   */
  private _stages: object = {};
  private _commitLog: { timestamp: number; message: string; data: any }[] = [];

  public _fullTextSearch: FullTextSearch;

  /**
   * @param {string} name - collection name
   * @param {(object)} [options={}] - a configuration object
   * @param {string[]} [options.unique=[]] - array of property names to define unique constraints for
   * @param {string[]} [options.exact=[]] - array of property names to define exact constraints for
   * @param {string[]} [options.indices=[]] - array property names to define binary indexes for
   * @param {boolean} [options.adaptiveBinaryIndices=true] - collection indices will be actively rebuilt rather than lazily
   * @param {boolean} [options.asyncListeners=false] - whether listeners are invoked asynchronously
   * @param {boolean} [options.disableMeta=false] - set to true to disable meta property on documents
   * @param {boolean} [options.disableChangesApi=true] - set to false to enable Changes API
   * @param {boolean} [options.disableDeltaChangesApi=true] - set to false to enable Delta Changes API (requires Changes API, forces cloning)
   * @param {boolean} [options.clone=false] - specify whether inserts and queries clone to/from user
   * @param {boolean} [options.serializableIndices =true] - converts date values on binary indexed property values are serializable
   * @param {string} [options.cloneMethod="deep"] - the clone method
   * @param {number} [options.transactional=false] - ?
   * @param {number} [options.ttl=] - age of document (in ms.) before document is considered aged/stale.
   * @param {number} [options.ttlInterval=] - time interval for clearing out 'aged' documents; not set by default
   * @param {FullTextSearch.FieldOptions} [options.fullTextSearch=] - the full-text search options
   * @see {@link Loki#addCollection} for normal creation of collections
   */
  constructor(name: string, options: Collection.Options<TData, TNested> = {}) {
    super();

    // Consistency checks.
    if (options && options.disableMeta === true) {
      if (options.disableChangesApi === false) {
        throw new Error("disableMeta option cannot be passed as true when disableChangesApi is passed as false");
      }
      if (options.disableDeltaChangesApi === false) {
        throw new Error("disableMeta option cannot be passed as true when disableDeltaChangesApi is passed as false");
      }
      if (typeof options.ttl === "number" && options.ttl > 0) {
        throw new Error("disableMeta option cannot be passed as true when ttl is enabled");
      }
    }

    // the name of the collection
    this.name = name;

    /* OPTIONS */
    // exact match and unique constraints
    if (options.unique !== undefined) {
      if (!Array.isArray(options.unique)) {
        options.unique = [options.unique];
      }
      options.unique.forEach((prop: keyof (TData & TNested)) => {
        this._constraints.unique[prop] = new UniqueIndex<TData & TNested>(prop);
      });
    }

    // Full text search
    if (PLUGINS["FullTextSearch"] !== undefined) {
      this._fullTextSearch = options.fullTextSearch !== undefined
        ? new (PLUGINS["FullTextSearch"])(options.fullTextSearch) : null;
    } else {
      this._fullTextSearch = null;
    }

    // .
    this._adaptiveBinaryIndices = options.adaptiveBinaryIndices !== undefined ? options.adaptiveBinaryIndices : true;

    // .
    this._transactional = options.transactional !== undefined ? options.transactional : false;

    // .
    this._cloneObjects = options.clone !== undefined ? options.clone : false;

    // .
    this._asyncListeners = options.asyncListeners !== undefined ? options.asyncListeners : false;

    // .
    this._disableMeta = options.disableMeta !== undefined ? options.disableMeta : false;

    // .
    this._disableChangesApi = options.disableChangesApi !== undefined ? options.disableChangesApi : true;

    // .
    this._disableDeltaChangesApi = options.disableDeltaChangesApi !== undefined ? options.disableDeltaChangesApi : true;

    // .
    this._cloneMethod = options.cloneMethod !== undefined ? options.cloneMethod : "deep";
    if (this._disableChangesApi) {
      this._disableDeltaChangesApi = true;
    }

    // .
    this._serializableIndices = options.serializableIndices !== undefined ? options.serializableIndices : true;

    // .
    if (options.nestedProperties != undefined) {
      for (let i = 0; i < options.nestedProperties.length; i++) {
        const nestedProperty = options.nestedProperties[i];
        if (typeof nestedProperty === "string") {
          this._nestedProperties.push({name: nestedProperty, path: nestedProperty.split(".")});
        } else {
          this._nestedProperties.push(nestedProperty as { name: keyof TNested, path: string[] });
        }
      }
    }

    this.setTTL(options.ttl || -1, options.ttlInterval);

    // events
    this._events = {
      "insert": [],
      "update": [],
      "pre-insert": [],
      "pre-update": [],
      "close": [],
      "flushbuffer": [],
      "error": [],
      "delete": [],
      "warning": []
    };

    // initialize the id index
    this._ensureId();
    let indices = options.indices ? options.indices : [];
    for (let idx = 0; idx < indices.length; idx++) {
      this.ensureIndex(options.indices[idx]);
    }

    this.setChangesApi(this._disableChangesApi, this._disableDeltaChangesApi);

    // for de-serialization purposes
    this.flushChanges();
  }

  toJSON(): Serialization.Collection {
    return {
      name: this.name,
      dynamicViews: this._dynamicViews.map(dV => dV.toJSON()),
      uniqueNames: Object.keys(this._constraints.unique),
      transforms: this._transforms as any,
      binaryIndices: this._binaryIndices as any,
      data: this._data,
      idIndex: this._idIndex,
      maxId: this._maxId,
      dirty: this._dirty,
      nestedProperties: this._nestedProperties,
      adaptiveBinaryIndices: this._adaptiveBinaryIndices,
      transactional: this._transactional,
      asyncListeners: this._asyncListeners,
      disableMeta: this._disableMeta,
      disableChangesApi: this._disableChangesApi,
      disableDeltaChangesApi: this._disableDeltaChangesApi,
      cloneObjects: this._cloneObjects,
      cloneMethod: this._cloneMethod,
      serializableIndices: this._serializableIndices,
      changes: this._changes,
      ttl: this._ttl.age,
      ttlInterval: this._ttl.interval,
      fullTextSearch: this._fullTextSearch ? this._fullTextSearch.toJSON() : null
    };
  }


  static fromJSONObject(obj: Serialization.Collection, options?: Collection.DeserializeOptions) {
    let coll = new Collection<any, any>(obj.name, {
      disableChangesApi: obj.disableChangesApi,
      disableDeltaChangesApi: obj.disableDeltaChangesApi
    });

    coll._adaptiveBinaryIndices = obj.adaptiveBinaryIndices !== undefined ? (obj.adaptiveBinaryIndices === true) : false;
    coll._transactional = obj.transactional;
    coll._asyncListeners = obj.asyncListeners;
    coll._disableMeta = obj.disableMeta;
    coll._disableChangesApi = obj.disableChangesApi;
    coll._cloneObjects = obj.cloneObjects;
    coll._cloneMethod = obj.cloneMethod || "deep";
    coll._changes = obj.changes;
    coll._nestedProperties = obj.nestedProperties;
    coll._serializableIndices = obj.serializableIndices;
    coll._dirty = (options && options.retainDirtyFlags === true) ? obj.dirty : false;

    function makeLoader(coll: Serialization.Collection) {
      const collOptions = options[coll.name];

      if (collOptions.proto) {
        const inflater = collOptions.inflate || ((src: Doc<any>, dest: Doc<any>) => {
          for (let prop in src) {
            dest[prop] = src[prop];
          }
        });

        return (data: Doc<any>) => {
          const collObj = new (collOptions.proto)();
          inflater(data, collObj);
          return collObj;
        };
      }

      return collOptions.inflate;
    }

    // load each element individually
    if (options && options[obj.name] !== undefined) {
      let loader = makeLoader(obj);

      for (let j = 0; j < obj.data.length; j++) {
        coll._data[j] = coll._defineNestedProperties(loader(obj.data[j]));
      }
    } else {
      for (let j = 0; j < obj.data.length; j++) {
        coll._data[j] = coll._defineNestedProperties(obj.data[j]);
      }
    }

    coll._maxId = (obj.maxId === undefined) ? 0 : obj.maxId;
    coll._idIndex = obj.idIndex;
    if (obj.binaryIndices !== undefined) {
      coll._binaryIndices = obj.binaryIndices;
    }
    if (obj.transforms !== undefined) {
      coll._transforms = obj.transforms;
    }

    coll._ensureId();

    // regenerate unique indexes
    if (obj.uniqueNames !== undefined) {
      for (let j = 0; j < obj.uniqueNames.length; j++) {
        coll.ensureUniqueIndex(obj.uniqueNames[j]);
      }
    }

    // in case they are loading a database created before we added dynamic views, handle undefined
    if (obj.dynamicViews !== undefined) {
      // reinflate DynamicViews and attached ResultSets
      for (let idx = 0; idx < obj.dynamicViews.length; idx++) {
        coll._dynamicViews.push(DynamicView.fromJSONObject(coll, obj.dynamicViews[idx]));
      }
    }

    if (obj.fullTextSearch) {
      coll._fullTextSearch = PLUGINS["FullTextSearch"].fromJSONObject(obj.fullTextSearch, options.fullTextSearch);
    }

    coll.setTTL(obj.ttl || -1, obj.ttlInterval);

    return coll;
  }

  /**
   * Adds a named collection transform to the collection
   * @param {string} name - name to associate with transform
   * @param {array} transform - an array of transformation 'step' objects to save into the collection
   */
  public addTransform(name: string, transform: Collection.Transform<TData, TNested>[]): void {
    if (this._transforms[name] !== undefined) {
      throw new Error("a transform by that name already exists");
    }
    this._transforms[name] = transform;
  }

  /**
   * Retrieves a named transform from the collection.
   * @param {string} name - name of the transform to lookup.
   */
  public getTransform(name: string): Collection.Transform<TData, TNested>[] {
    return this._transforms[name];
  }

  /**
   * Updates a named collection transform to the collection
   * @param {string} name - name to associate with transform
   * @param {object} transform - a transformation object to save into collection
   */
  public setTransform(name: string, transform: Collection.Transform<TData, TNested>[]): void {
    this._transforms[name] = transform;
  }

  /**
   * Removes a named collection transform from the collection
   * @param {string} name - name of collection transform to remove
   */
  public removeTransform(name: string): void {
    delete this._transforms[name];
  }

  /*----------------------------+
   | TTL                        |
   +----------------------------*/
  private setTTL(age: number, interval: number): void {
    if (age < 0) {
      clearInterval(this._ttl.daemon);
    } else {
      this._ttl.age = age;
      this._ttl.interval = interval;
      this._ttl.daemon = setInterval(() => {
        const now = Date.now();
        const toRemove = this.chain().where((member: Doc<TData>) => {
          const timestamp = member.meta.updated || member.meta.created;
          const diff = now - timestamp;
          return this._ttl.age < diff;
        });
        toRemove.remove();
      }, interval);
    }
  }

  /*----------------------------+
   | INDEXING                   |
   +----------------------------*/

  /**
   * Create a row filter that covers all documents in the collection.
   */
  _prepareFullDocIndex(): number[] {
    const indexes = new Array(this._data.length);
    for (let i = 0; i < indexes.length; i++) {
      indexes[i] = i;
    }
    return indexes;
  }

  /**
   * Ensure binary index on a certain field.
   * @param {string} field - the field name
   * @param {boolean} [force=false] - flag indicating whether to construct index immediately
   */
  public ensureIndex(field: keyof (TData & TNested), force = false) {
    if (this._binaryIndices[field] && !force && !this._binaryIndices[field].dirty) {
      return;
    }

    // if the index is already defined and we are using adaptiveBinaryIndices and we are not forcing a rebuild, return.
    if (this._adaptiveBinaryIndices === true && this._binaryIndices[field] !== undefined && !force) {
      return;
    }

    const index = {
      name: field,
      dirty: true,
      values: this._prepareFullDocIndex()
    };
    this._binaryIndices[field] = index;

    const wrappedComparer = (a: number, b: number) => {
      const val1 = this._data[a][field];
      const val2 = this._data[b][field];
      if (val1 !== val2) {
        if (ltHelper(val1, val2, false)) return -1;
        if (gtHelper(val1, val2, false)) return 1;
      }
      return 0;
    };

    index.values.sort(wrappedComparer);
    index.dirty = false;

    this._dirty = true; // for autosave scenarios
  }


  /**
   * Perform checks to determine validity/consistency of a binary index.
   * @param {string} field - the field name of the binary-indexed to check
   * @param {object=} options - optional configuration object
   * @param {boolean} [options.randomSampling=false] - whether (faster) random sampling should be used
   * @param {number} [options.randomSamplingFactor=0.10] - percentage of total rows to randomly sample
   * @param {boolean} [options.repair=false] - whether to fix problems if they are encountered
   * @returns {boolean} whether the index was found to be valid (before optional correcting).
   * @example
   * // full test
   * var valid = coll.checkIndex('name');
   * // full test with repair (if issues found)
   * valid = coll.checkIndex('name', { repair: true });
   * // random sampling (default is 10% of total document count)
   * valid = coll.checkIndex('name', { randomSampling: true });
   * // random sampling (sample 20% of total document count)
   * valid = coll.checkIndex('name', { randomSampling: true, randomSamplingFactor: 0.20 });
   * // random sampling (implied boolean)
   * valid = coll.checkIndex('name', { randomSamplingFactor: 0.20 });
   * // random sampling with repair (if issues found)
   * valid = coll.checkIndex('name', { repair: true, randomSampling: true });
   */
  public checkIndex(field: keyof (TData & TNested), options: Collection.CheckIndexOptions = {repair: false}) {
    // if lazy indexing, rebuild only if flagged as dirty
    if (!this._adaptiveBinaryIndices) {
      this.ensureIndex(field);
    }

    // if 'randomSamplingFactor' specified but not 'randomSampling', assume true
    if (options.randomSamplingFactor && options.randomSampling !== false) {
      options.randomSampling = true;
    }
    options.randomSamplingFactor = options.randomSamplingFactor || 0.1;
    if (options.randomSamplingFactor < 0 || options.randomSamplingFactor > 1) {
      options.randomSamplingFactor = 0.1;
    }

    const biv = this._binaryIndices[field].values;
    const len = biv.length;

    // if the index has an incorrect number of values
    if (len !== this._data.length) {
      if (options.repair) {
        this.ensureIndex(field, true);
      }
      return false;
    }

    if (len === 0) {
      return true;
    }

    let valid = true;
    if (len === 1) {
      valid = (biv[0] === 0);
    } else {
      if (options.randomSampling) {
        // validate first and last
        if (!LokiOps.$lte(this._data[biv[0]][field], this._data[biv[1]][field])) {
          valid = false;
        }
        if (!LokiOps.$lte(this._data[biv[len - 2]][field], this._data[biv[len - 1]][field])) {
          valid = false;
        }

        // if first and last positions are sorted correctly with their nearest neighbor,
        // continue onto random sampling phase...
        if (valid) {
          // # random samplings = total count * sampling factor
          const iter = Math.floor((len - 1) * options.randomSamplingFactor);

          // for each random sampling, validate that the binary index is sequenced properly
          // with next higher value.
          for (let idx = 0; idx < iter; idx++) {
            // calculate random position
            const pos = Math.floor(Math.random() * (len - 1));
            if (!LokiOps.$lte(this._data[biv[pos]][field], this._data[biv[pos + 1]][field])) {
              valid = false;
              break;
            }
          }
        }
      }
      else {
        // validate that the binary index is sequenced properly
        for (let idx = 0; idx < len - 1; idx++) {
          if (!LokiOps.$lte(this._data[biv[idx]][field], this._data[biv[idx + 1]][field])) {
            valid = false;
            break;
          }
        }
      }
    }

    // if incorrectly sequenced and we are to fix problems, rebuild index
    if (!valid && options.repair) {
      this.ensureIndex(field, true);
    }

    return valid;
  }

  /**
   * Perform checks to determine validity/consistency of all binary indices
   * @param {object=} options - optional configuration object
   * @param {boolean} [options.randomSampling=false] - whether (faster) random sampling should be used
   * @param {number} [options.randomSamplingFactor=0.10] - percentage of total rows to randomly sample
   * @param {boolean} [options.repair=false] - whether to fix problems if they are encountered
   * @returns {string[]} array of index names where problems were found
   * @example
   * // check all indices on a collection, returns array of invalid index names
   * var result = coll.checkAllIndexes({ repair: true, randomSampling: true, randomSamplingFactor: 0.15 });
   * if (result.length > 0) {
   *   results.forEach(function(name) {
   *     console.log('problem encountered with index : ' + name);
   *   });
   * }
   */
  public checkAllIndexes(options?: Collection.CheckIndexOptions): (keyof TData & TNested)[] {
    const results = [];
    let keys = Object.keys(this._binaryIndices) as (keyof TData & TNested)[];
    for (let i = 0; i < keys.length; i++) {
      const result = this.checkIndex(keys[i], options);
      if (!result) {
        results.push(keys[i]);
      }
    }
    return results;
  }

  public ensureUniqueIndex(field: keyof (TData & TNested)) {
    let index = new UniqueIndex<TData & TNested>(field);

    // if index already existed, (re)loading it will likely cause collisions, rebuild always
    this._constraints.unique[field] = index;
    for (let i = 0; i < this._data.length; i++) {
      index.set(this._data[i], i);
    }
    return index;
  }

  /**
   * Ensure all binary indices.
   */
  public ensureAllIndexes(force = false) {
    const keys = Object.keys(this._binaryIndices) as (keyof (TData & TNested))[];
    for (let i = 0; i < keys.length; i++) {
      this.ensureIndex(keys[i], force);
    }
  }

  public flagBinaryIndexesDirty() {
    const keys = Object.keys(this._binaryIndices) as (keyof (TData & TNested))[];
    for (let i = 0; i < keys.length; i++) {
      this.flagBinaryIndexDirty(keys[i]);
    }
  }

  public flagBinaryIndexDirty(index: keyof (TData & TNested)) {
    this._binaryIndices[index].dirty = true;
  }

  /**
   * Quickly determine number of documents in collection (or query)
   * @param {object} query - (optional) query object to count results of
   * @returns {number} number of documents in the collection
   */
  public count(query?: ResultSet.Query<Doc<TData & TNested>>): number {
    if (!query) {
      return this._data.length;
    }
    return this.chain().find(query)._filteredRows.length;
  }

  /**
   * Rebuild idIndex
   */
  private _ensureId(): void {
    this._idIndex = [];
    for (let i = 0; i < this._data.length; i++) {
      this._idIndex.push(this._data[i].$loki);
    }
  }

  /**
   * Add a dynamic view to the collection
   * @param {string} name - name of dynamic view to add
   * @param {object} options - (optional) options to configure dynamic view with
   * @param {boolean} [options.persistent=false] - indicates if view is to main internal results array in 'resultdata'
   * @param {string} [options.sortPriority=SortPriority.PASSIVE] - the sort priority
   * @param {number} options.minRebuildInterval - minimum rebuild interval (need clarification to docs here)
   * @returns {DynamicView} reference to the dynamic view added
   **/
  public addDynamicView(name: string, options?: DynamicView.Options): DynamicView<TData, TNested> {
    const dv = new DynamicView<TData, TNested>(this, name, options);
    this._dynamicViews.push(dv);

    return dv;
  }

  /**
   * Remove a dynamic view from the collection
   * @param {string} name - name of dynamic view to remove
   **/
  public removeDynamicView(name: string): void {
    for (let idx = 0; idx < this._dynamicViews.length; idx++) {
      if (this._dynamicViews[idx].name === name) {
        this._dynamicViews.splice(idx, 1);
      }
    }
  }

  /**
   * Look up dynamic view reference from within the collection
   * @param {string} name - name of dynamic view to retrieve reference of
   * @returns {DynamicView} A reference to the dynamic view with that name
   **/
  public getDynamicView(name: string): DynamicView<TData, TNested> {
    for (let idx = 0; idx < this._dynamicViews.length; idx++) {
      if (this._dynamicViews[idx].name === name) {
        return this._dynamicViews[idx];
      }
    }

    return null;
  }

  /**
   * Applies a 'mongo-like' find query object and passes all results to an update function.
   * @param {object} filterObject - the 'mongo-like' query object
   * @param {function} updateFunction - the update function
   */
  public findAndUpdate(filterObject: ResultSet.Query<Doc<TData & TNested>>, updateFunction: (obj: Doc<TData>) => any) {
    this.chain().find(filterObject).update(updateFunction);
  }

  /**
   * Applies a 'mongo-like' find query object removes all documents which match that filter.
   * @param {object} filterObject - 'mongo-like' query object
   */
  public findAndRemove(filterObject: ResultSet.Query<Doc<TData & TNested>>) {
    this.chain().find(filterObject).remove();
  }

  /**
   * Adds object(s) to collection, ensure object(s) have meta properties, clone it if necessary, etc.
   * @param {(object|array)} doc - the document (or array of documents) to be inserted
   * @returns {(object|array)} document or documents inserted
   */
  public insert(doc: TData): Doc<TData & TNested>;
  public insert(doc: TData[]): Doc<TData & TNested>[];
  public insert(doc: TData | TData[]): Doc<TData & TNested> | Doc<TData & TNested>[] {
    if (!Array.isArray(doc)) {
      return this.insertOne(doc);
    }

    // holder to the clone of the object inserted if collections is set to clone objects
    let obj;
    let results = [];

    this.emit("pre-insert", doc);
    for (let i = 0; i < doc.length; i++) {
      obj = this.insertOne(doc[i], true);
      if (!obj) {
        return undefined;
      }
      results.push(obj);
    }
    // at the 'batch' level, if clone option is true then emitted docs are clones
    this.emit("insert", results);

    // if clone option is set, clone return values
    results = this._cloneObjects ? clone(results, this._cloneMethod) : results;

    return results.length === 1 ? results[0] : results;
  }

  /**
   * Adds a single object, ensures it has meta properties, clone it if necessary, etc.
   * @param {object} doc - the document to be inserted
   * @param {boolean} bulkInsert - quiet pre-insert and insert event emits
   * @returns {object} document or 'undefined' if there was a problem inserting it
   */
  public insertOne(doc: TData, bulkInsert = false): Doc<TData & TNested> {
    let err = null;
    let returnObj;

    if (typeof doc !== "object") {
      err = new TypeError("Document needs to be an object");
    } else if (doc === null) {
      err = new TypeError("Object cannot be null");
    }

    if (err !== null) {
      this.emit("error", err);
      throw err;
    }

    // if configured to clone, do so now... otherwise just use same obj reference
    const obj = this._defineNestedProperties(this._cloneObjects ? clone(doc, this._cloneMethod) : doc);

    if (!this._disableMeta && (obj as Doc<TData>).meta === undefined) {
      (obj as Doc<TData>).meta = {
        version: 0,
        revision: 0,
        created: 0
      };
    }

    // both 'pre-insert' and 'insert' events are passed internal data reference even when cloning
    // insert needs internal reference because that is where loki itself listens to add meta
    if (!bulkInsert) {
      this.emit("pre-insert", obj);
    }
    if (!this._add(obj)) {
      return undefined;
    }

    // update meta and store changes if ChangesAPI is enabled
    // (moved from "insert" event listener to allow internal reference to be used)
    if (this._disableChangesApi) {
      this._insertMeta(obj as Doc<TData>);
    } else {
      this._insertMetaWithChange(obj as Doc<TData>);
    }

    // if cloning is enabled, emit insert event with clone of new object
    returnObj = this._cloneObjects ? clone(obj, this._cloneMethod) : obj;
    if (!bulkInsert) {
      this.emit("insert", returnObj);
    }

    return returnObj as Doc<TData & TNested>;
  }

  /**
   * Refers nested properties of an object to the root of it.
   * @param {T} data - the object
   * @returns {T & TNested} the object with nested properties
   * @hidden
   */
  _defineNestedProperties<T extends object>(data: T): T & TNested {
    for (let i = 0; i < this._nestedProperties.length; i++) {
      const name = this._nestedProperties[i].name;
      const path = this._nestedProperties[i].path;
      Object.defineProperty(data, name, {
        get() {
          // Get the value of the nested property.
          const array: any[] = [];
          if (getNestedPropertyValue(this, path, array)) {
            return array;
          } else {
            return array[0];
          }
        },
        set(val: any) {
          // Set the value of the nested property.
          path.slice(0, path.length - 1).reduce((obj: any, part: string) =>
            (obj && obj[part]) ? obj[part] : null, this)[path[path.length - 1]] = val;
        },
        enumerable: false,
        configurable: true
      });
    }
    return data as T & TNested;
  }

  /**
   * Empties the collection.
   * @param {boolean} [removeIndices=false] - remove indices
   */
  public clear({removeIndices: removeIndices = false} = {}) {
    this._data = [];
    this._idIndex = [];
    this._cached = null;
    this._maxId = 0;
    this._dynamicViews = [];
    this._dirty = true;

    // if removing indices entirely
    if (removeIndices === true) {
      this._binaryIndices = {};

      this._constraints = {
        unique: {}
      };
    }
    // clear indices but leave definitions in place
    else {
      // clear binary indices
      const keys = Object.keys(this._binaryIndices);
      keys.forEach((biname) => {
        this._binaryIndices[biname].dirty = false;
        this._binaryIndices[biname].values = [];
      });

      // clear entire unique indices definition
      const uniqueNames = Object.keys(this._constraints.unique);
      for (let i = 0; i < uniqueNames.length; i++) {
        this._constraints.unique[uniqueNames[i]].clear();
      }
    }

    if (this._fullTextSearch !== null) {
      this._fullTextSearch.clear();
    }
  }

  /**
   * Updates an object and notifies collection that the document has changed.
   * @param {object} doc - document to update within the collection
   */
  public update(doc: Doc<TData & TNested> | Doc<TData & TNested>[]): void {
    if (Array.isArray(doc)) {

      // If not cloning, disable adaptive binary indices for the duration of the batch update,
      // followed by lazy rebuild and re-enabling adaptive indices after batch update.
      const adaptiveBatchOverride = !this._cloneObjects && this._adaptiveBinaryIndices
        && Object.keys(this._binaryIndices).length > 0;
      if (adaptiveBatchOverride) {
        this._adaptiveBinaryIndices = false;
      }

      for (let i = 0; i < doc.length; i++) {
        this.update(doc[i]);
      }

      if (adaptiveBatchOverride) {
        this.ensureAllIndexes();
        this._adaptiveBinaryIndices = true;
      }

      return;
    }
    // Verify object is a properly formed document.
    if (doc.$loki === undefined) {
      throw new Error("Trying to update unsynced document. Please save the document first by using insert() or addMany()");
    }

    try {
      this.startTransaction();
      const arr = this.get(doc.$loki, true);

      if (!arr) {
        throw new Error("Trying to update a document not in collection.");
      }

      // ref to existing obj
      let oldInternal = arr[0]; // -internal- obj ref
      let position = arr[1]; // position in data array

      // ref to new internal obj
      // if configured to clone, do so now... otherwise just use same obj reference
      let newInternal = this._defineNestedProperties(this._cloneObjects || !this._disableDeltaChangesApi ? clone(doc, this._cloneMethod) : doc);

      this.emit("pre-update", doc);

      Object.keys(this._constraints.unique).forEach((key) => {
        this._constraints.unique[key].update(newInternal, position);
      });

      // operate the update
      this._data[position] = newInternal;

      // now that we can efficiently determine the data[] position of newly added document,
      // submit it for all registered DynamicViews to evaluate for inclusion/exclusion
      for (let idx = 0; idx < this._dynamicViews.length; idx++) {
        this._dynamicViews[idx]._evaluateDocument(position, false);
      }

      if (this._adaptiveBinaryIndices) {
        // for each binary index defined in collection, immediately update rather than flag for lazy rebuild
        const bIndices = Object.keys(this._binaryIndices) as (keyof (TData & TNested))[];
        for (let i = 0; i < bIndices.length; i++) {
          this.adaptiveBinaryIndexUpdate(position, bIndices[i]);
        }
      } else {
        this.flagBinaryIndexesDirty();
      }

      this._idIndex[position] = newInternal.$loki;

      // FullTextSearch.
      if (this._fullTextSearch !== null) {
        this._fullTextSearch.updateDocument(doc, position);
      }

      this.commit();
      this._dirty = true; // for autosave scenarios

      // update meta and store changes if ChangesAPI is enabled
      if (this._disableChangesApi) {
        this._updateMeta(newInternal);
      }
      else {
        this._updateMetaWithChange(newInternal, oldInternal);
      }

      let returnObj = newInternal;
      // if cloning is enabled, emit 'update' event and return with clone of new object
      if (this._cloneObjects) {
        returnObj = clone(newInternal, this._cloneMethod);
      }

      this.emit("update", returnObj, oldInternal);
    } catch (err) {
      this.rollback();
      this.emit("error", err);
      throw (err); // re-throw error so user does not think it succeeded
    }
  }

  /**
   * Add object to collection
   */
  private _add(obj: TData & TNested) {
    // if parameter isn't object exit with throw
    if ("object" !== typeof obj) {
      throw new TypeError("Object being added needs to be an object");
    }
    // if object you are adding already has id column it is either already in the collection
    // or the object is carrying its own 'id' property.  If it also has a meta property,
    // then this is already in collection so throw error, otherwise rename to originalId and continue adding.
    if (obj["$loki"] !== undefined) {
      throw new Error("Document is already in collection, please use update()");
    }

    /*
     * try adding object to collection
     */
    try {
      this.startTransaction();
      this._maxId++;

      if (isNaN(this._maxId)) {
        this._maxId = (this._data[this._data.length - 1].$loki + 1);
      }

      const newDoc = obj as Doc<TData & TNested>;
      newDoc.$loki = this._maxId;
      if (!this._disableMeta) {
        newDoc.meta.version = 0;
      }

      const constrUnique = this._constraints.unique;
      for (const key in constrUnique) {
        if (constrUnique[key] !== undefined) {
          constrUnique[key].set(newDoc, this._data.length);
        }
      }

      // add new obj id to idIndex
      this._idIndex.push(newDoc.$loki);

      // add the object
      this._data.push(newDoc);

      const addedPos = this._data.length - 1;

      // now that we can efficiently determine the data[] position of newly added document,
      // submit it for all registered DynamicViews to evaluate for inclusion/exclusion
      const dvlen = this._dynamicViews.length;
      for (let i = 0; i < dvlen; i++) {
        this._dynamicViews[i]._evaluateDocument(addedPos, true);
      }

      if (this._adaptiveBinaryIndices) {
        // for each binary index defined in collection, immediately update rather than flag for lazy rebuild
        const bIndices = Object.keys(this._binaryIndices) as (keyof (TData & TNested))[];
        for (let i = 0; i < bIndices.length; i++) {
          this.adaptiveBinaryIndexInsert(addedPos, bIndices[i]);
        }
      } else {
        this.flagBinaryIndexesDirty();
      }

      // FullTextSearch.
      if (this._fullTextSearch !== null) {
        this._fullTextSearch.addDocument(newDoc, addedPos);
      }

      this.commit();
      this._dirty = true; // for autosave scenarios

      return (this._cloneObjects) ? (clone(newDoc, this._cloneMethod)) : (newDoc);
    } catch (err) {
      this.rollback();
      this.emit("error", err);
      throw (err); // re-throw error so user does not think it succeeded
    }
  }

  /**
   * Applies a filter function and passes all results to an update function.
   * @param {function} filterFunction - the filter function
   * @param {function} updateFunction - the update function
   */
  updateWhere(filterFunction: (obj: Doc<TData & TNested>) => boolean, updateFunction: (obj: Doc<TData & TNested>) => Doc<TData & TNested>) {
    const results = this.where(filterFunction);
    try {
      for (let i = 0; i < results.length; i++) {
        this.update(updateFunction(results[i]));
      }
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  /**
   * Remove all documents matching supplied filter function.
   * @param {function} filterFunction - the filter function
   */
  public removeWhere(filterFunction: (obj: Doc<TData & TNested>) => boolean) {
    this.remove(this._data.filter(filterFunction));
  }

  public removeDataOnly() {
    this.remove(this._data.slice());
  }

  /**
   * Remove a document from the collection
   * @param {number|object} doc - document to remove from collection
   */
  remove(doc: number | Doc<TData & TNested> | Doc<TData & TNested>[]): void {
    if (typeof doc === "number") {
      doc = this.get(doc);
    }

    if (Array.isArray(doc)) {
      let k = 0;
      const len = doc.length;
      for (k; k < len; k++) {
        this.remove(doc[k]);
      }
      return;
    }
    if (doc.$loki === undefined) {
      throw new Error("Object is not a document stored in the collection");
    }

    try {
      this.startTransaction();
      const arr = this.get(doc.$loki, true);

      const position = arr[1];

      Object.keys(this._constraints.unique).forEach((key) => {
        if (doc[key] !== null && doc[key] !== undefined) {
          this._constraints.unique[key].remove(doc[key]);
        }
      });
      // now that we can efficiently determine the data[] position of newly added document,
      // submit it for all registered DynamicViews to remove
      for (let idx = 0; idx < this._dynamicViews.length; idx++) {
        this._dynamicViews[idx]._removeDocument(position);
      }

      if (this._adaptiveBinaryIndices) {
        // for each binary index defined in collection, immediately update rather than flag for lazy rebuild
        const bIndices = Object.keys(this._binaryIndices) as (keyof (TData & TNested))[];
        for (let i = 0; i < bIndices.length; i++) {
          this.adaptiveBinaryIndexRemove(position, bIndices[i]);
        }
      } else {
        this.flagBinaryIndexesDirty();
      }

      this._data.splice(position, 1);

      // remove id from idIndex
      this._idIndex.splice(position, 1);

      // FullTextSearch.
      if (this._fullTextSearch !== null) {
        this._fullTextSearch.removeDocument(doc, position);
      }

      this.commit();
      this._dirty = true; // for autosave scenarios

      if (!this._disableChangesApi) {
        this._createChange(this.name, "R", arr[0]);
      }

      this.emit("delete", arr[0]);
      delete doc.$loki;
      delete doc.meta;
    } catch (err) {
      this.rollback();
      this.emit("error", err);
      throw err;
    }
  }

  /*------------+
   | Change API |
   +------------*/
  /**
   * Returns all changes.
   * @returns {Collection.Change[]}
   */
  public getChanges(): Collection.Change[] {
    return this._changes;
  }

  /**
   * Enables/disables changes api.
   * @param {boolean} disableChangesApi
   * @param {boolean} disableDeltaChangesApi
   */
  public setChangesApi(disableChangesApi: boolean, disableDeltaChangesApi: boolean = true) {
    this._disableChangesApi = disableChangesApi;
    this._disableDeltaChangesApi = disableChangesApi ? true : disableDeltaChangesApi;
  }

  /**
   * Clears all the changes.
   */
  public flushChanges() {
    this._changes = [];
  }

  private _getObjectDelta(oldObject: Doc<TData>, newObject: Doc<TData>) {
    const propertyNames = newObject !== null && typeof newObject === "object" ? Object.keys(newObject) : null;
    if (propertyNames && propertyNames.length && ["string", "boolean", "number"].indexOf(typeof(newObject)) < 0) {
      const delta = {};
      for (let i = 0; i < propertyNames.length; i++) {
        const propertyName = propertyNames[i];
        if (newObject.hasOwnProperty(propertyName)) {
          if (!oldObject.hasOwnProperty(propertyName) || this._constraints.unique[propertyName] !== undefined
            || propertyName === "$loki" || propertyName === "meta") {
            delta[propertyName] = newObject[propertyName];
          } else {
            const propertyDelta = this._getObjectDelta(oldObject[propertyName], newObject[propertyName]);
            if (propertyDelta !== undefined && propertyDelta !== {}) {
              delta[propertyName] = propertyDelta;
            }
          }
        }
      }
      return Object.keys(delta).length === 0 ? undefined : delta;
    } else {
      return oldObject === newObject ? undefined : newObject;
    }
  }

  /**
   * Compare changed object (which is a forced clone) with existing object and return the delta
   */
  private _getChangeDelta(obj: Doc<TData>, old: Doc<TData>) {
    if (old) {
      return this._getObjectDelta(old, obj);
    } else {
      return JSON.parse(JSON.stringify(obj));
    }
  }

  /**
   * Creates a clone of the current status of an object and associates operation and collection name,
   * so the parent db can aggregate and generate a changes object for the entire db
   */
  private _createChange(name: string, op: string, obj: Doc<TData>, old?: Doc<TData>) {
    this._changes.push({
      name,
      operation: op,
      obj: op === "U" && !this._disableDeltaChangesApi
        ? this._getChangeDelta(obj, old)
        : JSON.parse(JSON.stringify(obj))
    });
  }

  private _createInsertChange(obj: Doc<TData>) {
    this._createChange(this.name, "I", obj);
  }

  private _createUpdateChange(obj: Doc<TData>, old: Doc<TData>) {
    this._createChange(this.name, "U", obj, old);
  }

  private _insertMetaWithChange(obj: Doc<TData>) {
    this._insertMeta(obj);
    this._createInsertChange(obj);
  }

  private _updateMetaWithChange(obj: Doc<TData>, old: Doc<TData>) {
    this._updateMeta(obj);
    this._createUpdateChange(obj, old);
  }

  private _insertMeta(obj: Doc<TData>) {
    if (this._disableMeta) {
      return;
    }

    if (!obj.meta) {
      obj.meta = {
        version: 0,
        revision: 0,
        created: 0
      };
    }
    obj.meta.created = (new Date()).getTime();
    obj.meta.revision = 0;
  }

  private _updateMeta(obj: Doc<TData>) {
    if (this._disableMeta) {
      return;
    }

    obj.meta.updated = (new Date()).getTime();
    obj.meta.revision += 1;
  }

  /*---------------------+
   | Finding methods     |
   +----------------------*/

  /**
   * Get by Id - faster than other methods because of the searching algorithm
   * @param {int} id - $loki id of document you want to retrieve
   * @param {boolean} returnPosition - if 'true' we will return [object, position]
   * @returns {(object|array|null)} Object reference if document was found, null if not,
   *     or an array if 'returnPosition' was passed.
   */
  public get(id: number): Doc<TData & TNested>;
  public get(id: number, returnPosition: boolean): Doc<TData & TNested> | [Doc<TData & TNested>, number];
  public get(id: number, returnPosition = false) {
    const data = this._idIndex;
    let max = data.length - 1;
    let min = 0;
    let mid = (min + max) >> 1;

    id = typeof id === "number" ? id : parseInt(id, 10);

    if (isNaN(id)) {
      throw new TypeError("Passed id is not an integer");
    }

    while (data[min] < data[max]) {
      mid = (min + max) >> 1;

      if (data[mid] < id) {
        min = mid + 1;
      } else {
        max = mid;
      }
    }

    if (max === min && data[min] === id) {
      if (returnPosition) {
        return [this._data[min], min];
      }
      return this._data[min];
    }
    return null;
  }

  /**
   * Perform binary range lookup for the data[dataPosition][binaryIndexName] property value
   *    Since multiple documents may contain the same value (which the index is sorted on),
   *    we hone in on range and then linear scan range to find exact index array position.
   * @param {int} dataPosition : data array index/position
   * @param {string} binaryIndexName : index to search for dataPosition in
   */
  public getBinaryIndexPosition(dataPosition: number, binaryIndexName: keyof (TData & TNested)) {
    const val = this._data[dataPosition][binaryIndexName];
    const index = this._binaryIndices[binaryIndexName].values;

    // i think calculateRange can probably be moved to collection
    // as it doesn't seem to need ResultSet.  need to verify
    //let rs = new ResultSet(this, null, null);
    const range = this.calculateRange("$eq", binaryIndexName, val);

    if (range[0] === 0 && range[1] === -1) {
      // uhoh didn't find range
      return null;
    }

    const min = range[0];
    const max = range[1];

    // narrow down the sub-segment of index values
    // where the indexed property value exactly matches our
    // value and then linear scan to find exact -index- position
    for (let idx = min; idx <= max; idx++) {
      if (index[idx] === dataPosition) return idx;
    }

    // uhoh
    return null;
  }

  /**
   * Adaptively insert a selected item to the index.
   * @param {int} dataPosition : coll.data array index/position
   * @param {string} binaryIndexName : index to search for dataPosition in
   */
  public adaptiveBinaryIndexInsert(dataPosition: number, binaryIndexName: keyof (TData & TNested)) {
    const index = this._binaryIndices[binaryIndexName].values;
    let val: any = this._data[dataPosition][binaryIndexName];

    // If you are inserting a javascript Date value into a binary index, convert to epoch time
    if (this._serializableIndices === true && val instanceof Date) {
      this._data[dataPosition][binaryIndexName] = val.getTime() as any;
      val = this._data[dataPosition][binaryIndexName];
    }

    const idxPos = (index.length === 0) ? 0 : this._calculateRangeStart(binaryIndexName, val, true);

    // insert new data index into our binary index at the proper sorted location for relevant property calculated by idxPos.
    // doing this after adjusting dataPositions so no clash with previous item at that position.
    this._binaryIndices[binaryIndexName].values.splice(idxPos, 0, dataPosition);
  }

  /**
   * Adaptively update a selected item within an index.
   * @param {int} dataPosition : coll.data array index/position
   * @param {string} binaryIndexName : index to search for dataPosition in
   */
  public adaptiveBinaryIndexUpdate(dataPosition: number, binaryIndexName: keyof (TData & TNested)) {
    // linear scan needed to find old position within index unless we optimize for clone scenarios later
    // within (my) node 5.6.0, the following for() loop with strict compare is -much- faster than indexOf()
    let idxPos;

    const index = this._binaryIndices[binaryIndexName].values;
    const len = index.length;

    for (idxPos = 0; idxPos < len; idxPos++) {
      if (index[idxPos] === dataPosition) break;
    }

    //let idxPos = this.binaryIndices[binaryIndexName].values.indexOf(dataPosition);
    this._binaryIndices[binaryIndexName].values.splice(idxPos, 1);

    //this.adaptiveBinaryIndexRemove(dataPosition, binaryIndexName, true);
    this.adaptiveBinaryIndexInsert(dataPosition, binaryIndexName);
  }

  /**
   * Adaptively remove a selected item from the index.
   * @param {number} dataPosition : coll.data array index/position
   * @param {string} binaryIndexName : index to search for dataPosition in
   * @param {boolean} removedFromIndexOnly - remove from index only
   */
  public adaptiveBinaryIndexRemove(dataPosition: number, binaryIndexName: keyof (TData & TNested), removedFromIndexOnly = false): void {
    const idxPos = this.getBinaryIndexPosition(dataPosition, binaryIndexName);
    if (idxPos === null) {
      return;
    }

    // remove document from index
    this._binaryIndices[binaryIndexName].values.splice(idxPos, 1);

    // if we passed this optional flag parameter, we are calling from adaptiveBinaryIndexUpdate,
    // in which case data positions stay the same.
    if (removedFromIndexOnly === true) {
      return;
    }

    // since index stores data array positions, if we remove a document
    // we need to adjust array positions -1 for all document positions greater than removed position
    const index = this._binaryIndices[binaryIndexName].values;
    for (let idx = 0; idx < index.length; idx++) {
      if (index[idx] > dataPosition) {
        index[idx]--;
      }
    }
  }

  /**
   * Internal method used for index maintenance and indexed searching.
   * Calculates the beginning of an index range for a given value.
   * For index maintainance (adaptive:true), we will return a valid index position to insert to.
   * For querying (adaptive:false/undefined), we will :
   *    return lower bound/index of range of that value (if found)
   *    return next lower index position if not found (hole)
   * If index is empty it is assumed to be handled at higher level, so
   * this method assumes there is at least 1 document in index.
   *
   * @param {string} prop - name of property which has binary index
   * @param {any} val - value to find within index
   * @param {bool?} adaptive - if true, we will return insert position
   */
  private _calculateRangeStart(prop: keyof (TData & TNested), val: any, adaptive = false): number {
    const rcd = this._data;
    const index = this._binaryIndices[prop].values;
    let min = 0;
    let max = index.length - 1;
    let mid = 0;

    if (index.length === 0) {
      return -1;
    }

    // hone in on start position of value
    while (min < max) {
      mid = (min + max) >> 1;

      if (ltHelper(rcd[index[mid]][prop], val, false)) {
        min = mid + 1;
      } else {
        max = mid;
      }
    }

    const lbound = min;

    // found it... return it
    if (aeqHelper(val, rcd[index[lbound]][prop])) {
      return lbound;
    }

    // if not in index and our value is less than the found one
    if (ltHelper(val, rcd[index[lbound]][prop], false)) {
      return adaptive ? lbound : lbound - 1;
    }

    // not in index and our value is greater than the found one
    return adaptive ? lbound + 1 : lbound;
  }

  /**
   * Internal method used for indexed $between.  Given a prop (index name), and a value
   * (which may or may not yet exist) this will find the final position of that upper range value.
   */
  private _calculateRangeEnd(prop: keyof (TData & TNested), val: any) {
    const rcd = this._data;
    const index = this._binaryIndices[prop].values;
    let min = 0;
    let max = index.length - 1;
    let mid = 0;

    if (index.length === 0) {
      return -1;
    }

    // hone in on start position of value
    while (min < max) {
      mid = (min + max) >> 1;

      if (ltHelper(val, rcd[index[mid]][prop], false)) {
        max = mid;
      } else {
        min = mid + 1;
      }
    }

    const ubound = max;

    // only eq if last element in array is our val
    if (aeqHelper(val, rcd[index[ubound]][prop])) {
      return ubound;
    }

    // if not in index and our value is less than the found one
    if (gtHelper(val, rcd[index[ubound]][prop], false)) {
      return ubound + 1;
    }

    // either hole or first nonmatch
    if (aeqHelper(val, rcd[index[ubound - 1]][prop])) {
      return ubound - 1;
    }

    // hole, so ubound if nearest gt than the val we were looking for
    return ubound;
  }

  /**
   * Binary Search utility method to find range/segment of values matching criteria.
   *    this is used for collection.find() and first find filter of ResultSet/dynview
   *    slightly different than get() binary search in that get() hones in on 1 value,
   *    but we have to hone in on many (range)
   * @param {string} op - operation, such as $eq
   * @param {string} prop - name of property to calculate range for
   * @param {object} val - value to use for range calculation.
   * @returns {array} [start, end] index array positions
   */
  public calculateRange(op: string, prop: keyof (TData & TNested), val: any): [number, number] {
    const rcd = this._data;
    const index = this._binaryIndices[prop].values;
    const min = 0;
    const max = index.length - 1;
    let lbound;
    let lval;
    let ubound;

    // when no documents are in collection, return empty range condition
    if (rcd.length === 0) {
      return [0, -1];
    }

    const minVal = rcd[index[min]][prop];
    const maxVal = rcd[index[max]][prop];

    // if value falls outside of our range return [0, -1] to designate no results
    switch (op) {
      case "$eq":
      case "$aeq":
        if (ltHelper(val, minVal, false) || gtHelper(val, maxVal, false)) {
          return [0, -1];
        }
        break;
      case "$dteq":
        if (ltHelper(val, minVal, false) || gtHelper(val, maxVal, false)) {
          return [0, -1];
        }
        break;
      case "$gt":
        // none are within range
        if (gtHelper(val, maxVal, true)) {
          return [0, -1];
        }
        // all are within range
        if (gtHelper(minVal, val, false)) {
          return [min, max];
        }
        break;
      case "$gte":
        // none are within range
        if (gtHelper(val, maxVal, false)) {
          return [0, -1];
        }
        // all are within range
        if (gtHelper(minVal, val, true)) {
          return [min, max];
        }
        break;
      case "$lt":
        // none are within range
        if (ltHelper(val, minVal, true)) {
          return [0, -1];
        }
        // all are within range
        if (ltHelper(maxVal, val, false)) {
          return [min, max];
        }
        break;
      case "$lte":
        // none are within range
        if (ltHelper(val, minVal, false)) {
          return [0, -1];
        }
        // all are within range
        if (ltHelper(maxVal, val, true)) {
          return [min, max];
        }
        break;
      case "$between":
        // none are within range (low range is greater)
        if (gtHelper(val[0], maxVal, false)) {
          return [0, -1];
        }
        // none are within range (high range lower)
        if (ltHelper(val[1], minVal, false)) {
          return [0, -1];
        }

        lbound = this._calculateRangeStart(prop, val[0]);
        ubound = this._calculateRangeEnd(prop, val[1]);

        if (lbound < 0) lbound++;
        if (ubound > max) ubound--;

        if (!gtHelper(rcd[index[lbound]][prop], val[0], true)) lbound++;
        if (!ltHelper(rcd[index[ubound]][prop], val[1], true)) ubound--;

        if (ubound < lbound) return [0, -1];

        return ([lbound, ubound]);
    }

    // determine lbound where needed
    switch (op) {
      case "$eq":
      case "$aeq":
      case "$dteq":
      case "$gte":
      case "$lt":
        lbound = this._calculateRangeStart(prop, val);
        lval = rcd[index[lbound]][prop];
        break;
      default:
        break;
    }

    // determine ubound where needed
    switch (op) {
      case "$eq":
      case "$aeq":
      case "$dteq":
      case "$lte":
      case "$gt":
        ubound = this._calculateRangeEnd(prop, val);
        break;
      default:
        break;
    }


    switch (op) {
      case "$eq":
      case "$aeq":
      case "$dteq":
        if (!aeqHelper(lval, val)) {
          return [0, -1];
        }
        return [lbound, ubound];

      case "$gt":
        // (an eqHelper would probably be better test)
        // if hole (not found) ub position is already greater
        if (!aeqHelper(rcd[index[ubound]][prop], val)) {
          //if (gtHelper(rcd[index[ubound]][prop], val, false)) {
          return [ubound, max];
        }
        // otherwise (found) so ubound is still equal, get next
        return [ubound + 1, max];

      case "$gte":
        // if hole (not found) lb position marks left outside of range
        if (!aeqHelper(rcd[index[lbound]][prop], val)) {
          //if (ltHelper(rcd[index[lbound]][prop], val, false)) {
          return [lbound + 1, max];
        }
        // otherwise (found) so lb is first position where its equal
        return [lbound, max];

      case "$lt":
        // if hole (not found) position already is less than
        if (!aeqHelper(rcd[index[lbound]][prop], val)) {
          //if (ltHelper(rcd[index[lbound]][prop], val, false)) {
          return [min, lbound];
        }
        // otherwise (found) so lb marks left inside of eq range, get previous
        return [min, lbound - 1];

      case "$lte":
        // if hole (not found) ub position marks right outside so get previous
        if (!aeqHelper(rcd[index[ubound]][prop], val)) {
          //if (gtHelper(rcd[index[ubound]][prop], val, false)) {
          return [min, ubound - 1];
        }
        // otherwise (found) so ub is last position where its still equal
        return [min, ubound];

      default:
        return [0, rcd.length - 1];
    }
  }

  /**
   * Retrieve doc by Unique index
   * @param {string} field - name of uniquely indexed property to use when doing lookup
   * @param {any} value - unique value to search for
   * @returns {object} document matching the value passed
   */
  public by(field: keyof (TData & TNested), value: any): Doc<TData & TNested> {
    return this.findOne({[field]: value} as any);
  }

  /**
   * Find one object by index property, by property equal to value
   * @param {object} query - query object used to perform search with
   * @returns {(object|null)} First matching document, or null if none
   */
  public findOne(query: ResultSet.Query<Doc<TData & TNested>>): Doc<TData & TNested> {
    query = query || {};

    // Instantiate ResultSet and exec find op passing firstOnly = true param
    const result = this.chain().find(query, true).data();

    if (Array.isArray(result) && result.length === 0) {
      return null;
    } else {
      if (!this._cloneObjects) {
        return result[0] as any as Doc<TData & TNested>;
      } else {
        return clone(result[0], this._cloneMethod) as any as Doc<TData & TNested>;
      }
    }
  }

  /**
   * Chain method, used for beginning a series of chained find() and/or view() operations
   * on a collection.
   *
   * @param {array} transform - Ordered array of transform step objects similar to chain
   * @param {object} parameters - Object containing properties representing parameters to substitute
   * @returns {ResultSet} (this) ResultSet, or data array if any map or join functions where called
   */
  public chain(transform?: string | Collection.Transform<TData, TNested>[], parameters?: object): ResultSet<TData, TNested> {
    const rs = new ResultSet<TData, TNested>(this);
    if (transform === undefined) {
      return rs;
    }
    return rs.transform(transform, parameters);
  }

  /**
   * Find method, api is similar to mongodb.
   * for more complex queries use [chain()]{@link Collection#chain} or [where()]{@link Collection#where}.
   * @example {@tutorial Query Examples}
   * @param {object} query - 'mongo-like' query object
   * @returns {array} Array of matching documents
   */
  public find(query?: ResultSet.Query<Doc<TData & TNested>>): Doc<TData & TNested>[] {
    return this.chain().find(query).data();
  }

  /**
   * Find object by unindexed field by property equal to value,
   * simply iterates and returns the first element matching the query
   */
  public findOneUnindexed(prop: string, value: any) {
    let i = this._data.length;
    let doc;
    while (i--) {
      if (this._data[i][prop] === value) {
        doc = this._data[i];
        return doc;
      }
    }
    return null;
  }

  /**
   * Transaction methods
   */

  /**
   * start the transation
   */
  public startTransaction(): void {
    if (this._transactional) {
      this._cached = {
        index: this._idIndex,
        data: clone(this._data, this._cloneMethod),
        binaryIndex: this._binaryIndices,
      };

      // propagate startTransaction to dynamic views
      for (let idx = 0; idx < this._dynamicViews.length; idx++) {
        this._dynamicViews[idx].startTransaction();
      }
    }
  }

  /**
   * Commit the transaction.
   */
  public commit(): void {
    if (this._transactional) {
      this._cached = null;

      // propagate commit to dynamic views
      for (let idx = 0; idx < this._dynamicViews.length; idx++) {
        this._dynamicViews[idx].commit();
      }
    }
  }

  /**
   * Rollback the transaction.
   */
  public rollback(): void {
    if (this._transactional) {
      if (this._cached !== null) {
        this._idIndex = this._cached.index;
        this._data = this._defineNestedProperties(this._cached.data);
        this._binaryIndices = this._cached.binaryIndex;

        // propagate rollback to dynamic views
        for (let idx = 0; idx < this._dynamicViews.length; idx++) {
          this._dynamicViews[idx].rollback();
        }
      }
    }
  }

  /**
   * Query the collection by supplying a javascript filter function.
   * @example
   * let results = coll.where(function(obj) {
	 *   return obj.legs === 8;
	 * });
   * @param {function} fun - filter function to run against all collection docs
   * @returns {array} all documents which pass your filter function
   */
  public where(fun: (obj: Doc<TData & TNested>) => boolean): Doc<TData & TNested>[] {
    return this.chain().where(fun).data();
  }

  /**
   * Map Reduce operation
   * @param {function} mapFunction - function to use as map function
   * @param {function} reduceFunction - function to use as reduce function
   * @returns {data} The result of your mapReduce operation
   */
  public mapReduce<T, U>(mapFunction: (value: Doc<TData & TNested>, index: number, array: Doc<TData & TNested>[]) => T, reduceFunction: (array: T[]) => U): U {
    return reduceFunction(this._data.map(mapFunction));
  }

  /**
   * Join two collections on specified properties
   * @param {array} joinData - array of documents to 'join' to this collection
   * @param {string} leftJoinProp - property name in collection
   * @param {string} rightJoinProp - property name in joinData
   * @param {function} mapFun - (Optional) map function to use
   * @param dataOptions - options to data() before input to your map function
   * @param [dataOptions.removeMeta] - allows removing meta before calling mapFun
   * @param [dataOptions.forceClones] - forcing the return of cloned objects to your map object
   * @param [dataOptions.forceCloneMethod] - allows overriding the default or collection specified cloning method
   * @returns {ResultSet} Result of the mapping operation
   */
  public eqJoin(joinData: Collection<any> | ResultSet<any> | any[], leftJoinProp: string | ((obj: any) => string),
                rightJoinProp: string | ((obj: any) => string), mapFun?: (left: any, right: any) => any,
                dataOptions?: ResultSet.DataOptions): ResultSet<any> {
    return new ResultSet(this).eqJoin(joinData, leftJoinProp, rightJoinProp, mapFun, dataOptions);
  }

  /* ------ STAGING API -------- */

  /**
   * (Staging API) create a stage and/or retrieve it
   */
  getStage(name: string) {
    if (!this._stages[name]) {
      this._stages[name] = {};
    }
    return this._stages[name];
  }

  /**
   * a collection of objects recording the changes applied through a commmitStage
   */

  /**
   * (Staging API) create a copy of an object and insert it into a stage
   */
  public stage<F extends TData>(stageName: string, obj: Doc<F>): F {
    const copy = JSON.parse(JSON.stringify(obj));
    this.getStage(stageName)[obj.$loki] = copy;
    return copy;
  }

  /**
   * (Staging API) re-attach all objects to the original collection, so indexes and views can be rebuilt
   * then create a message to be inserted in the commitlog
   * @param {string} stageName - name of stage
   * @param {string} message
   */
  public commitStage(stageName: string, message: string) {
    const stage = this.getStage(stageName);
    const timestamp = new Date().getTime();

    for (const prop in stage) {
      this.update(stage[prop]);
      this._commitLog.push({
        timestamp,
        message,
        data: JSON.parse(JSON.stringify(stage[prop]))
      });
    }
    this._stages[stageName] = {};
  }

  /**
   * Returns all values of a field.
   * @param {string} field - the field name
   * @return {any}: the array of values
   */
  public extract(field: keyof (TData & TNested)): any[] {
    const result = [];
    for (let i = 0; i < this._data.length; i++) {
      result.push(this._data[i][field]);
    }
    return result;
  }

  /**
   * Finds the minimum value of a field.
   * @param {string} field - the field name
   * @return {number} the minimum value
   */
  public min(field: keyof (TData & TNested)): number {
    return Math.min.apply(null, this.extractNumerical(field));
  }

  /**
   * Finds the maximum value of a field.
   * @param {string} field - the field name
   * @return {number} the maximum value
   */
  public max(field: keyof (TData & TNested)): number {
    return Math.max.apply(null, this.extractNumerical(field));
  }

  /**
   * Finds the minimum value and its index of a field.
   * @param {string} field - the field name
   * @return {object} - index and value
   */
  public minRecord(field: keyof (TData & TNested)) {
    const result = {
      index: 0,
      value: 0
    };

    if (this._data.length === 0) {
      result.index = null;
      result.value = null;
      return result;
    }

    result.index = this._data[0].$loki;
    result.value = parseFloat(this._data[0][field] as any);
    for (let i = 1; i < this._data.length; i++) {
      const val = parseFloat(this._data[i][field] as any);
      if (result.value > val) {
        result.value = val;
        result.index = this._data[i].$loki;
      }
    }
    return result;
  }

  /**
   * Finds the maximum value and its index of a field.
   * @param {string} field - the field name
   * @return {object} - index and value
   */
  public maxRecord(field: keyof (TData & TNested)) {
    const result = {
      index: 0,
      value: 0
    };

    if (this._data.length === 0) {
      result.index = null;
      result.value = null;
      return result;
    }

    result.index = this._data[0].$loki;
    result.value = parseFloat(this._data[0][field] as any);
    for (let i = 1; i < this._data.length; i++) {
      const val = parseFloat(this._data[i][field] as any);
      if (result.value < val) {
        result.value = val;
        result.index = this._data[i].$loki;
      }
    }
    return result;
  }

  /**
   * Returns all values of a field as numbers (if possible).
   * @param {string} field - the field name
   * @return {number[]} - the number array
   */
  public extractNumerical(field: keyof (TData & TNested)) {
    return this.extract(field).map(parseFloat).filter(Number).filter((n) => !(isNaN(n)));
  }

  /**
   * Calculates the average numerical value of a field
   * @param {string} field - the field name
   * @returns {number} average of property in all docs in the collection
   */
  public avg(field: keyof (TData & TNested)): number {
    return average(this.extractNumerical(field));
  }

  /**
   * Calculate the standard deviation of a field.
   * @param {string} field - the field name
   * @return {number} the standard deviation
   */
  public stdDev(field: keyof (TData & TNested)): number {
    return standardDeviation(this.extractNumerical(field));
  }

  /**
   * Calculates the mode of a field.
   * @param {string} field - the field name
   * @return {number} the mode
   */
  public mode(field: keyof (TData & TNested)): number {
    const dict = {};
    const data = this.extractNumerical(field);

    let mode = data[0];
    let maxCount = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const el = data[i];
      if (dict[el]) {
        dict[el]++;
      } else {
        dict[el] = 1;
      }
      if (dict[el] > maxCount) {
        mode = el;
        maxCount = dict[el];
      }
    }
    return mode;
  }

  /**
   * Calculates the median of a field.
   * @param {string} field - the field name
   * @return {number} the median
   */
  public median(field: keyof (TData & TNested)) {
    const values = this.extractNumerical(field);
    values.sort((a, b) => a - b);

    const half = Math.floor(values.length / 2);

    if (values.length % 2) {
      return values[half];
    } else {
      return (values[half - 1] + values[half]) / 2.0;
    }
  }
}

export namespace Collection {
  export interface Options<TData extends object, TNested extends object = {}> {
    unique?: (keyof (TData & TNested))[];
    indices?: (keyof (TData & TNested))[];
    adaptiveBinaryIndices?: boolean;
    asyncListeners?: boolean;
    disableMeta?: boolean;
    disableChangesApi?: boolean;
    disableDeltaChangesApi?: boolean;
    clone?: boolean;
    serializableIndices?: boolean;
    cloneMethod?: CloneMethod;
    transactional?: boolean;
    ttl?: number;
    ttlInterval?: number;
    nestedProperties?: (keyof TNested | { name: keyof TNested, path: string[] })[];
    fullTextSearch?: FullTextSearch.FieldOptions[];
  }

  export interface DeserializeOptions {
    retainDirtyFlags?: boolean;
    fullTextSearch?: Dict<Analyzer>;
    loader?: (databaseVersion: number, coll: Serialization.Collection, options: Collection.Options<any, any>) => boolean;

    [collName: string]: any | { proto?: any; inflate?: (src: object, dest?: object) => void };
  }

  export interface BinaryIndex {
    dirty: boolean;
    values: number[];
  }

  export interface Change {
    name: string;
    operation: string;
    obj: any;
  }

  export interface CheckIndexOptions {
    randomSampling?: boolean;
    randomSamplingFactor?: number;
    repair?: boolean;
  }

  export type Transform<TData extends object = object, TNested extends object = object> = {
    type: "find";
    value: ResultSet.Query<Doc<TData & TNested>> | string;
  } | {
    type: "where";
    value: ((obj: Doc<TData & TNested>) => boolean) | string;
  } | {
    type: "simplesort";
    property: keyof (TData & TNested);
    options?: boolean | ResultSet.SimpleSortOptions;
  } | {
    type: "compoundsort";
    value: (keyof (TData & TNested) | [keyof (TData & TNested), boolean])[];
  } | {
    type: "sort";
    value: (a: Doc<TData & TNested>, b: Doc<TData & TNested>) => number;
  } | {
    type: "sortByScoring";
    desc?: boolean;
  } | {
    type: "limit";
    value: number;
  } | {
    type: "offset";
    value: number;
  } | {
    type: "map";
    value: (obj: Doc<TData & TNested>, index: number, array: Doc<TData & TNested>[]) => any;
    dataOptions?: ResultSet.DataOptions;
  } | {
    type: "eqJoin";
    joinData: Collection<any> | ResultSet<any>;
    leftJoinKey: string | ((obj: any) => string);
    rightJoinKey: string | ((obj: any) => string);
    mapFun?: (left: any, right: any) => any;
    dataOptions?: ResultSet.DataOptions;
  } | {
    type: "mapReduce";
    mapFunction: (item: Doc<TData & TNested>, index: number, array: Doc<TData & TNested>[]) => any;
    reduceFunction: (array: any[]) => any;
  } | {
    type: "update";
    value: (obj: Doc<TData & TNested>) => any;
  } | {
    type: "remove";
  };

  export interface TTL {
    age: number;
    interval: number;
    daemon: any; // setInterval Timer
  }
}
