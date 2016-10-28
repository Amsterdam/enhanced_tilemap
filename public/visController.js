/*
 * Had to rework original tilemap functionallity to migrate 
 * to TemplateVisType. Combined pieces from 
 *   plugins/kbn_vislib_vis_types/public/tileMap.js
 *   ui/public/vislib/visualizations/tile_map.js
 */
import d3 from 'd3';
import _ from 'lodash';
import $ from 'jquery';
import Binder from 'ui/binder';
import MapProvider from 'plugins/enhanced_tilemap/vislib/_map';
import VislibVisTypeBuildChartDataProvider from 'ui/vislib_vis_type/build_chart_data';

define(function (require) {
  var module = require('ui/modules').get('kibana/enhanced_tilemap', ['kibana']);
  
  module.controller('KbnEnhancedTilemapVisController', function ($scope, $rootScope, $element, Private, courier, config, getAppState) {
    let buildChartData = Private(VislibVisTypeBuildChartDataProvider);
    const queryFilter = Private(require('ui/filter_bar/query_filter'));
    const pushFilter = Private(require('ui/filter_bar/push_filter'))(getAppState());
    const callbacks = Private(require('plugins/enhanced_tilemap/callbacks'));
    const utils = require('plugins/enhanced_tilemap/utils');
    let TileMapMap = Private(MapProvider);
    const ResizeChecker = Private(require('ui/vislib/lib/resize_checker'));
    let map = null;
    let collar = null;
    let chartData = null;
    appendMap();
    modifyToDsl();

    const binder = new Binder();
    const resizeChecker = new ResizeChecker($element);
    binder.on(resizeChecker, 'resize', function() {
      resizeArea();
    });

    const respProcessor = {
      buildChartData: buildChartData,
      process: function(resp) {
        const aggs = resp.aggregations;
        let numGeoBuckets = 0;
        _.keys(aggs).forEach(function(key) {
          if(_.has(aggs[key], "filtered_geohash")) {
            aggs[key].buckets = aggs[key].filtered_geohash.buckets;
            delete aggs[key].filtered_geohash;
            numGeoBuckets = aggs[key].buckets.length;
          }
        });
        console.log("geogrids: " + numGeoBuckets);
        if(numGeoBuckets === 0) return null;

        const chartData = this.buildChartData(resp);
        const geoMinMax = utils.getGeoExtents(chartData);
        chartData.geoJson.properties.allmin = geoMinMax.min;
        chartData.geoJson.properties.allmax = geoMinMax.max;
        return chartData;
      },
      vis: $scope.vis
    }

    function modifyToDsl() {
      $scope.vis.aggs.origToDsl = $scope.vis.aggs.toDsl;
      $scope.vis.aggs.toDsl = function() {
        resizeArea();
        const dsl = $scope.vis.aggs.origToDsl();
        
        //append map collar filter to geohash_grid aggregation
        _.keys(dsl).forEach(function(key) {
          if(_.has(dsl[key], "geohash_grid")) {
            const origAgg = dsl[key];
            dsl[key] = {
              filter: aggFilter(origAgg.geohash_grid.field),
              aggs: {
                filtered_geohash: origAgg
              }
            }
          }
        });
        return dsl;
      }
    }

    function aggFilter(field) {
      collar = utils.scaleBounds(
        map.mapBounds(), 
        $scope.vis.params.collarScale);
      var filter = {geo_bounding_box: {}};
      filter.geo_bounding_box[field] = collar;
      return filter;
    }

    $scope.$watch('vis.aggs', function (resp) {
      //'apply changes' creates new vis.aggs object - ensure toDsl is overwritten again
      if(!_.has($scope.vis.aggs, "origToDsl")) {
        modifyToDsl();
      }
    });

    $scope.$watch('vis.params', function (resp) {
      draw();
    });

    $scope.$watch('esResponse', function (resp) {
      if(_.has(resp, 'aggregations')) {
        chartData = respProcessor.process(resp);
        draw();
      }
    });

    $scope.$on("$destroy", function() {
      binder.destroy();
      resizeChecker.destroy();
      if (map) map.destroy();
    });

    function draw() {
      if(!chartData) return;
      const agg = _.get(chartData, 'geohashGridAgg');
      if (agg) {
        map.addFilters(getGeoFilters(agg.fieldName()));
      }
      if (_.get($scope.vis.params, 'overlay.wms.enabled')) {
        addWmsOverlays();
      }
      map.addMarkers(
        chartData, 
        $scope.vis.params,
        Private(require('ui/agg_response/geo_json/_tooltip_formatter')),
        _.get(chartData, 'valueFormatter', _.identity),
        collar);
    }

    function getGeoFilters(field) {
      let filters = [];
      _.flatten([queryFilter.getAppFilters(), queryFilter.getGlobalFilters()]).forEach(function (it) {
        if (utils.isGeoFilter(it, field) && !_.get(it, 'meta.disabled', false)) {
          const features = utils.filterToGeoJson(it, field);
          filters = filters.concat(features);
        }
      });
      return filters;
    }

    function addWmsOverlays() {
      const url = _.get($scope.vis.params, 'overlay.wms.url');
      const name = _.get($scope.vis.params, 'overlay.wms.options.displayName', 'WMS Overlay');
      const options = {
        format: 'image/png',
        layers: _.get($scope.vis.params, 'overlay.wms.options.layers'),
        transparent: true,
        version: '1.1.1'
      };
      if (_.get($scope.vis.params, 'overlay.wms.options.viewparams.enabled')) {
        const source = new courier.SearchSource();
        const appState = getAppState();
        source.set('filter', queryFilter.getFilters());
        if (appState.query && !appState.linked) {
          source.set('query', appState.query);
        }
        source._flatten().then(function (fetchParams) {
          const esQuery = fetchParams.body.query;
          //remove kibana parts of query
          const cleanedMust = [];
          if (_.has(esQuery, 'filtered.filter.bool.must')) {
            esQuery.filtered.filter.bool.must.forEach(function(must) {
              cleanedMust.push(_.omit(must, ['$state', '$$hashKey']));
            });
          }
          esQuery.filtered.filter.bool.must = cleanedMust;
          const cleanedMustNot = [];
          if (_.has(esQuery, 'filtered.filter.bool.must_not')) {
            esQuery.filtered.filter.bool.must_not.forEach(function(mustNot) {
              cleanedMustNot.push(_.omit(mustNot, ['$state', '$$hashKey']));
            });
          }
          esQuery.filtered.filter.bool.must_not = cleanedMustNot;
          
          options.viewparams = 'q:' + JSON.stringify(esQuery).replace(new RegExp('[,]', 'g'), '\\,');
          map.addWmsOverlay(url, name, options);
        });
      } else {
        map.addWmsOverlay(url, name, options);
      }
    }

    function appendMap() {
      callbacks.setPushFilter(pushFilter);
      const initialMapState = utils.getMapStateFromVis($scope.vis);
      var params = $scope.vis.params;
      var container = $element[0].querySelector('.tilemap');
      map = new TileMapMap(container, {
        center: initialMapState.center,
        zoom: initialMapState.zoom,
        callbacks: callbacks,
        mapType: params.mapType,
        attr: params,
        editable: $scope.vis.getEditableVis() ? true : false
      });
    }

    function resizeArea() {
      if (map) map.updateSize();
    }
  });
});
