function debug(output){
    console.log(`[Leaflet] ${output}`);
}

function jsonToLatLng(obj){
    if(typeof obj !== 'object' || !('lat' in obj) || !('lng' in obj) || typeof obj.lat !== 'number' || typeof obj.lng !== 'number'){
        RPGM.newJavascriptError({message: 'Could not convert an object to a LatLng object!'});
    }
    return L.latLng(obj.lat, obj.lng);
}

/**
 * Manage all the maps in the app.
 */
const LeafletMapManager = new class {
    constructor(){
        this._currentStepCache = null;
        this._maps = [];
        this._icons = [];
    }

    /**
     * Initialize the map manager by setting hook on the RPGM app.
     */
    initialize(){
        // Send R the current step
        RPGM.on('didEnterStep', (stepId)=>{
            debug('Sending onDidEnterStep...');
            this._currentStepCache = stepId;
            RPGM.sendMessage('r', 'leaflet/onDidEnterStep', {stepId: this._currentStepCache});
        });

        // When receiving a message
        RPGM.on('didReceiveMessage', (message, data)=>{
            if(message === 'leaflet/enterStep' && this._currentStepCache !== null){
                debug('Force to send onDidEnterStep...');
                RPGM.sendMessage('r', 'leaflet/onDidEnterStep', {stepId: this._currentStepCache});
                return;
            }
            if(message === 'leaflet/icon/create'){
                this._icons[data.iconId] = L.icon(data.options);
                return;
            }
            if(message === 'leaflet/initialize'){
                debug('Initializing a new map...');
                const mapInstance = new LeafletMap({
                    id: data.mapId,
                    layer: data.layer,
                    height: data.height,
                    options: data.options,
                    layerOptions: data.layerOptions
                });
                return;
            }

            // All next messages requires a mapId
            const mapInstance = this.getMap(data.mapId);
            if(mapInstance === undefined){
                return;
            }

            // Packets
            if(message === 'leaflet/map/view'){
                mapInstance.setView(data.center, data.zoom);
            }
            else if(message === 'leaflet/map/zoom'){
                mapInstance.setZoom(data.zoom);
            }
            else if(message === 'leaflet/map/fit'){
                mapInstance.fitBounds(data.bounds);
            }
            else if(message === 'leaflet/markers/update'){
                mapInstance.updateMarkers(data.markers);
            }
            else if(message === 'leaflet/legend/update'){
                mapInstance.updateLegend(data.content);
            }
            else if(message === 'leaflet/geojson/add'){
                mapInstance.addGeoJSON(data.zoneId, data.points, data.tooltip, data.color);
            }
            else if(message === 'leaflet/geojson/flush'){
                mapInstance.flushGeoJSON();
            }
            else if(message === 'leaflet/loading/show'){
                mapInstance.loadingShow();
            }
            else if(message === 'leaflet/loading/false'){
                mapInstance.loadingHide();
            }
        });
    }

    /**
     * Return a map by its id or undefined if not found.
     */
    getMap(mapId){
        return this._maps.find(m => m.getId() === mapId);
    }

    /**
     * Return an icon by its id or undefined if not found.
     */
    getIcon(iconId){
        return this._icons.find(m => m.id === iconId);
    }
}
LeafletMapManager.initialize();

/**
 * This class manages the leaflet map.
 */
class LeafletMap {
    constructor(options){
        this._id = options.id;

        /** All draw stuff */
        this._queueGeoJSON = [];
        this._lastGeoJSON = null;
        this._markers = [];

        /** Timer to not send too much changes to RPGM */
        this._debouncer = null;

        /** JS binding */
        this.sendChange = this.sendChange.bind(this);
        this.onMapViewChange = this.onMapViewChange.bind(this);
        this.highlightFeature = this.highlightFeature.bind(this);
        this.resetHighlight = this.resetHighlight.bind(this);
        this.zoomToFeature = this.zoomToFeature.bind(this);

        // Create map
        if(options.options.center){
            options.options.center = jsonToLatLng(options.options.center);
        }
        this._map = L.map(`leaflet-${options.id}`, options.options);
        this._map.whenReady(()=>{
            RPGM.sendMessage('r', 'leaflet/onDidLoad', {
                id: this._id
            });
        });
        L.tileLayer(options.layer, options.layerOptions).addTo(this._map);

        // Info popup
        this._tooltip = L.control();
        this._tooltip.onAdd = function(map){
            this._div = L.DomUtil.create('div', 'info');
            this.update();
            return this._div;
        };
        this._tooltip.update = function(props){
            this._div.style.display = props ? 'block' : 'none';
            this._div.innerHTML = props ? props.tooltip : '';
        };
        this._tooltip.addTo(this._map);

        // Legend
        this._legend = L.control({position: 'bottomright'});
        this._legend.onAdd = (map)=>{
            this._legendDiv = L.DomUtil.create('div', 'info map-legend');
            this._legendDiv.innerHTML = 'Légende';
            return this._legendDiv;
        };
        this._legend.addTo(this._map);

        // Detect zoom change and drag
        this._map.on('zoomend', this.onMapViewChange);
        this._map.on('moveend', this.onMapViewChange);

        // Use for debugging (to delete)
        this._map.on('click', (e)=>{
            RPGM.sendMessage('r', 'leaflet/onDidClickMap', {
                id: this._id,
                lat: e.latlng.lat,
                lng: e.latlng.lng
            });
        });
    }

    getId(){
        return this._id;
    }

    /**
     * This function is called when the user changes the zoom or drag the map.
     * It debounces the call to R by setting a timer.
     */
    onMapViewChange(){
        if(this._debouncer !== null){
            clearTimeout(this._debouncer);
        }
        this._debouncer = setTimeout(this.sendChange, 200); // 200ms
    }

    /**
     * Actually send the map state to R.
     */
    sendChange(){
        RPGM.sendMessage('r', 'leaflet/onDidChangeView', {
            id: this._id,
            northLat: this._map.getBounds().getNorth(),
            eastLng: this._map.getBounds().getEast(),
            southLat: this._map.getBounds().getSouth(),
            westLng: this._map.getBounds().getWest(),
            zoomLevel: this._map.getZoom()
        });
    }

    addGeoJSON(id, points, tooltip, color){
        this._queueGeoJSON.push({points, id, tooltip, color});
    }

    drawGeoJSON(geojson){
        if(this._lastGeoJSON){
            this._lastGeoJSON.remove();
        }
        
        const finalGeo = ({
            type: "FeatureCollection",
            features: this._queueGeoJSON.map(e => {
                let isMultiple = false;
                try {
                    isMultiple = Array.isArray(e.points[0][0]);
                }
                catch{
                    isMultiple = false;
                }
                
                const oo = {
                    type: "Feature",
                    properties: {
                        id: `${e.id}`,
                        color: e.color,
                        tooltip: e.tooltip
                    },
                    geometry: {
                        type: isMultiple ? "MultiPolygon" : "Polygon",
                        coordinates: isMultiple ? e.points.map(p => [p]) : [e.points]
                    }
                };
                return oo;
            })
        });
        this._queueGeoJSON = [];

        this._lastGeoJSON = L.geoJson(finalGeo, {
            style: (feature)=>{
                return {
                    fillColor: feature.properties.color,
                    opacity: 1,
                    color: 'white',
                    dashArray: 3,
                    fillOpacity: 0.6
                }
            },
            onEachFeature: (feature, layer)=>{
                layer.on({
                    mouseover: this.highlightFeature,
                    mouseout: this.resetHighlight,
                    click: this.zoomToFeature
                });
            }
        });
        this._lastGeoJSON.addTo(this._map);
    }

    highlightFeature(e){
        const layer = e.target;
        layer.setStyle({
            weight: 5,
            color: '#666',
            dashArray: '',
            fillOpacity: 0.7
        });
        layer.bringToFront();
        this._mapInfo.update(layer.feature.properties);
    }

    resetHighlight(e){
        this._lastGeoJSON.resetStyle(e.target);
        this._mapInfo.update();
    }

    zoomToFeature(e){
        RPGM.sendMessage('r', 'onDidClickZone', {
            id: this._id,
            zoneId: e.target.feature.properties.id
        });
    }

    updateLegend(content){
        this._legendDiv.innerHTML = content;
    }

    updateMarkers(markers){
        this._markers.map(m => m.remove());
        this._markers = [];
        markers.forEach(m => {
            const newMarker = L.marker([m.lat, m.lng], {icon: this._markerIcon});
            newMarker.bindPopup(m.label);
            newMarker.on('mouseover',function(ev){
                newMarker.openPopup();
            });
            newMarker.addTo(this._map);
            this._markers.push(newMarker);
        });
    }

    loadingShow(){

    }

    loadingHide(){

    }
}