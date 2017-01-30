define([
    'jquery',
    'underscore',
    'd3',
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
],
function(
    $,
    _,
    d3,
    SplunkVisualizationBase,
    SplunkVisualizationUtils
) {
    // Extend from SplunkVisualizationBase
    return SplunkVisualizationBase.extend({
        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.$el = $(this.el);

            this.tooltip = d3.select("body")
                .append("div")
                    .attr("id", "tooltip");

            this.$el.append('<div id="riddon_controls"><label>Choose ribbon types: </label><select id="ribbon_dropdown"><option value="all">All</option></select></div>');
        },

        // Optionally implement to format data returned from search.
        // The returned object will be passed to updateView as 'data'
        formatData: function(raw_data) {
            if(raw_data.results.length < 1) {
                return false;
            }

            _.mixin({
                "total": function(data, key) {
                    return _(data).chain()
                        .pluck(key)
                        .reduce(function(memo, num) {
                            return memo + parseFloat(num);
                        }, 0)
                        .value();
                }
            });

            function by_ribbon(data, inner) {
                return _(data).chain()
                    .groupBy("ribbon")
                    .map(function(v, k) {
                        var obj = {
                            "ribbon": k,
                            "total": _(v).total("count")
                        }

                        if(inner) obj.inner = inner;

                        return obj;
                })
                .value();
            };

            var data = {};

            data.stats = {
                "total": _(raw_data.results).total("count"),
                "ribbon": by_ribbon(raw_data.results, null),
                "inner": _(raw_data.results).chain()
                        .groupBy("inner")
                        .map(function(v, k) {
                            return {
                                "inner": k,
                                "total": _(v).total("count"),
                                "ribbon": by_ribbon(v, k)
                            };
                        })
                        .value()
            };

            _(data.stats.ribbon).each(function(o) {
                if(!$("#ribbon_dropdown option[value=" + o.ribbon + "]").length) {
                    $("#ribbon_dropdown").append('<option value="' + o.ribbon + '">' + o.ribbon + '</option>');
                }
            });

            data.outer = _(raw_data.results).map(function(v, i) {
                v.count = parseFloat(v.count);
                v._index = i;

                return v;
            });

            data.inner = _(data.outer).chain()
                .groupBy("inner")
                .map(function(v, k) {
                    return {
                        "inner": k,
                        "data": v
                    };
                })
                .value();

            return data;
        },

        // Implement updateView to render a visualization.
        //  'data' will be the data object returned from formatData or from the search
        //  'config' will be the configuration property object
        updateView: function(data, config) {
            var that = this;

            if(!data) {
                return;
            }

            debugger;

            this.$el.find("svg").remove();

            var ribbon_choice = "all",
                animation = false,
                width = that.$el.width() * 0.8,
                height = width * 0.8,
                radius = width / 2 * 0.55,
                radius_label = radius * 1.1, // default radius for label before label_relax()
                thickness = radius * 0.07,
                ribbon_radius_cp_offset = radius * 0.2,
                radius_pack = 0.8 * (radius - thickness),
                padding_pack = radius * 0.1,
                opacity_ribbon = 0.6,
                opacity_fade = 0.1,
                label_font_size = height * 0.014,
                label_spacing = radius * 0.01, // px between the text label and line
                label_wrap_length = radius * 0.7, // wrap to under in px
                label_relax_delta = 0.5, // increment in px to separate colliding labels per label_relax() execution
                label_relax_sleep = 10, // sleep label_relax() in ms
                transition_duration = 750; // in ms

            var color_outer = d3.scaleOrdinal(d3.schemeCategory20b);

            that.tooltip_position = function() {
                that.tooltip
                    .style("top", (d3.event.pageY - 10) + "px")
                    .style("left", (d3.event.pageX + 10) + "px");
            }

            String.prototype.capitalize = function() {
                return this.charAt(0).toUpperCase() + this.slice(1);
            }

            that.number_format = d3.format(",d");

            that.pct_label = function(pct) {
                return pct < 1 ? "<1%" : Math.round(pct) + "%";
            }

            that.get_translate = function(translate) {
                var match = /^translate\(([^,]+),(.+)\)/.exec(translate);
                return [parseFloat(match[1]), parseFloat(match[2])];
            }

            var svg = d3.select(that.el)
                .append("svg")
                    .attr("width", width)
                    .attr("height", height)
                .append("g")
                    .attr("transform", "translate(" + [width / 2, height / 2] + ")");

            var outer = svg
                .append("g")
                    .attr("class", "outer");

            var middle = svg
                .append("g")
                    .attr("class", "middle");

            var inner = svg
                .append("g")
                    .attr("class", "inner")
                    .attr("transform", "translate(" + [-radius_pack, -radius_pack] + ")");

            var label = svg
                .append("g")
                    .attr("class", "front");

            var arc_outer = d3.arc()
                .innerRadius(radius - thickness)
                .outerRadius(radius);

            var pie_outer = d3.pie()
                .value(function(d) {
                    return d.ribbon === ribbon_choice || ribbon_choice === "all" ? d.count : 0;
                })
                .sort(null);

            function mouseout_default() {
                if(animation) return;

                that.tooltip.style("visibility", "hidden");

                path_outer_g
                    .transition()
                    .style("opacity", 1.0);

                ribbon
                    .transition()
                    .style("opacity", opacity_ribbon);

                path_inner_g
                    .transition()
                    .style("opacity", 1.0);

                image
                    .transition()
                    .style("opacity", 1.0);
            }

            function mouseover_outer(d) {
                if(animation) return;

                var outer_label = d.data.outer.capitalize(),
                    ribbon_label = d.data.ribbon,
                    inner_label = d.data.inner.capitalize(),
                    count = d.data.count,
                    total = data.stats.total,
                    total_ribbon = _(data.stats.ribbon).findWhere({"ribbon": ribbon_label}).total,
                    pct = count / total * 100,
                    pct_ribbon = count / total_ribbon * 100;

                var html = outer_label + " -> " + ribbon_label + " -> " + inner_label + ": " + that.number_format(count);

                html += ribbon_choice === "all" ?
                    "<br>" + that.pct_label(pct) + " of total amount" :
                    "<br>" + ribbon_label + ": " + that.pct_label(pct_ribbon) + " of total amount";

                html += "<br><i>Click for more details</i>";

                that.tooltip
                    .style("visibility", "visible")
                    .html(html);

                path_outer_g
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data._index === dd.data._index ? 1.0 : opacity_fade;
                    });

                ribbon
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data._index === dd.data._index ? opacity_ribbon : opacity_fade;
                    });

                path_inner_g
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data._index === dd.data._index ? 1.0 : opacity_fade;
                    });

                image
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data.inner === dd.data.inner ? 1.0 : opacity_fade;
                    });
            }

            var path_outer_g = outer.selectAll("g.arc_outer")
                .data(pie_outer(data.outer))
                .enter()
                .append("g")
                    .attr("class", "arc_outer")
                    .on("mouseover", mouseover_outer)
                    .on("mousemove", that.tooltip_position)
                    .on("mouseout", mouseout_default)
                    .on("click", function(d) {
                        var committee_id = d.data.committee_id;

                        if(committee_id !== "none") {
                            window.open("https://beta.fec.gov/data/committee/" + committee_id, "_blank");
                        }
                    });

            var path_outer = path_outer_g
                .append("path")
                    .attr("d", arc_outer)
                    .attr("fill", function(d) {
                        return color_outer(d.data.outer);
                    })
                    .each(function(d) {
                        this._current = d;
                    });

            var label_group = label.selectAll("g.label-group")
                .data(pie_outer(data.outer))
                .enter()
                .append("g")
                    .attr("class", "label-group")
                    .attr("visibility", "visible")
                    .on("mouseover", mouseover_outer)
                    .on("mousemove", that.tooltip_position)
                    .on("mouseout", mouseout_default)
                    .on("click", function(d) {
                        var committee_id = d.data.committee_id;

                        if(committee_id !== "none") {
                            window.open("https://beta.fec.gov/data/committee/" + committee_id, "_blank");
                        }
                    });

            var label_circle = label_group
                .append("circle")
                    .attr("x", 0)
                    .attr("y", 0)
                    .attr("r", 2)
                    .attr("transform", function (d, i) {
                        return "translate(" + arc_outer.centroid(d) + ")";
                    })
                    .attr("class", "label-circle")
                    .each(function(d) {
                        this._current = d;
                    });

            var label_line = label_group
                .append("line")
                    .attr("x1", function (d) {
                        return arc_outer.centroid(d)[0];
                    })
                    .attr("y1", function (d) {
                        return arc_outer.centroid(d)[1];
                    })
                    .attr("x2", function (d) {
                        var c = arc_outer.centroid(d),
                            mid_angle = Math.atan2(c[1], c[0]),
                            x = Math.cos(mid_angle) * radius_label;
                        return x;
                    })
                    .attr("y2", function (d) {
                        var c = arc_outer.centroid(d),
                            mid_angle = Math.atan2(c[1], c[0]),
                            y = Math.sin(mid_angle) * radius_label;
                        return y;
                    })
                    .attr("class", "label-line")
                    .each(function(d) {
                        this._current = d;
                    });

            var label_text_g = label_group
                .append("g")
                    .attr("class", "label-text-group")
                    .attr("transform", function(d) {
                        var c = arc_outer.centroid(d),
                            mid_angle = Math.atan2(c[1], c[0]),
                            x = Math.cos(mid_angle) * radius_label,
                            sign = (x > 0) ? 1 : -1,
                            label_x = x + (2 * sign),
                            label_y = Math.sin(mid_angle) * radius_label;
                        return "translate(" + [label_x, label_y] + ")";
                    })
                    .each(function(d) {
                        this._current = d;
                    });

            var label_text = label_text_g
                .append("text")
                    .attr("x", 0)
                    .attr("y", 0)
                    .attr("dy", "0em")
                    .attr("text-anchor", function (d) {
                        var c = arc_outer.centroid(d),
                            mid_angle = Math.atan2(c[1], c[0]),
                            x = Math.cos(mid_angle) * radius_label;
                        return (x > 0) ? "start" : "end";
                    })
                    .attr("class", "label-text")
                    .attr("dominant-baseline", "middle")
                    .style("font-size", label_font_size)
                    .text(function (d) {
                        return d.data.outer;
                    })
                    .each(function(d) {
                        this._current = d;
                    })
                    .call(label_wrap, label_wrap_length);

            label_relax();

            // https://bl.ocks.org/mbostock/7555321
            function label_wrap(text, width) {
                text.each(function() {
                    var text = d3.select(this),
                        g = d3.select(this.parentNode),
                        words = text.text().split(/\s+/).reverse(),
                        word,
                        wrapped = false,
                        line = [],
                        lineNumber = 0,
                        lineHeight = 1.1, // ems
                        dy = parseFloat(text.attr("dy")),
                        tspan = text.text(null)
                            .append("tspan")
                                .attr("x", 0)
                                .attr("y", 0)
                                .attr("dy", dy + "em");
                    while(word = words.pop()) {
                        line.push(word);
                        tspan.text(line.join(" "));
                        if(tspan.node().getComputedTextLength() > width) {
                            wrapped = true;
                            line.pop();
                            tspan.text(line.join(" "));
                            line = [word];
                            tspan = text
                                .append("tspan")
                                    .attr("x", 0)
                                    .attr("y", 0)
                                    .attr("dy", ++lineNumber * lineHeight + dy + "em")
                                    .text(word);

                        }
                    }
                });
            }

            // Based off of https://jsfiddle.net/thudfactor/HdwTH/
            function label_relax() {
                var adjusted = false;
                label_text_g
                    .filter(function() {
                        return d3.select(this.parentNode).attr("visibility") !== "hidden";
                    })
                    .each(function() {
                        var a = this;

                        label_text_g
                            .filter(function() {
                                return d3.select(this.parentNode).attr("visibility") !== "hidden";
                            })
                            .each(function () {
                                var b = this,
                                    da = d3.select(a),
                                    db = d3.select(b),
                                    ta = da.select("text").attr("text-anchor"),
                                    tb = db.select("text").attr("text-anchor");

                                if(a === b || ta !== tb) return;

                                var ra = a.getBoundingClientRect(),
                                    rb = b.getBoundingClientRect();

                                var overlap = ra.top - label_spacing < rb.bottom &&
                                            rb.top - label_spacing < ra.bottom &&
                                            ra.left - label_spacing < rb.right &&
                                            rb.left - label_spacing < ra.right;

                                if(!overlap) return;

                                adjusted = true;

                                var fa = that.get_translate(da.attr("transform")),
                                    fb = that.get_translate(db.attr("transform")),
                                    xa = fa[0],
                                    ya = fa[1],
                                    xb = fb[0],
                                    yb = fb[1],
                                    aa = da.datum().endAngle,
                                    ab = db.datum().endAngle,
                                    adjust = ta === "start" && aa > ab || ta === "end" && aa < ab ? label_relax_delta : -label_relax_delta;

                                da.attr("transform", "translate(" + [xa, ya + adjust] + ")");
                                db.attr("transform", "translate(" + [xb, yb - adjust] + ")");
                            });
                    });

                if(adjusted) {
                    label_line.attr("y2", function(d, i) {
                        var g_for_line = label_text_g.filter(function(dd, ii) {
                            return i === ii;
                        });
                            y = that.get_translate(g_for_line.attr("transform"))[1];
                        return y;
                    });

                    setTimeout(label_relax, label_relax_sleep)
                }
            }

            var bubble_inner = d3.pack()
                .size([2 * radius_pack, 2 * radius_pack])
                .padding(padding_pack);

            var root = d3.hierarchy({"children": data.inner})
                .sum(function(d) {
                    return _(d.data).chain()
                        .filter(function(v) {
                            return v.ribbon === ribbon_choice || ribbon_choice === "all";
                        })
                        .pluck("count")
                        .reduce(function(memo, num) {
                            return memo + num;
                        }, 0)
                        .value();
                });

            var drag = d3.drag()
                .on("start", function() {
                    animation = true;
                    that.tooltip.style("visibility", "hidden");
                })
                .on("drag", function(d) {
                    var relative_x = d3.event.x - radius_pack,
                        relative_y = radius_pack - d3.event.y,
                        relative_r = Math.sqrt(Math.pow(relative_x, 2) + Math.pow(relative_y, 2)),
                        limit_r = radius - 2 * thickness - d.r;

                    if(relative_r >= limit_r) {
                        var theta = Math.atan2(relative_y, relative_x),
                            new_relative_x = limit_r * Math.cos(theta),
                            new_relative_y = limit_r * Math.sin(theta);

                        d.x = new_relative_x + radius_pack;
                        d.y = -new_relative_y + radius_pack;
                    }
                    else {
                        d.x = d3.event.x;
                        d.y = d3.event.y;
                    }

                    d3.select(this).attr("transform", function(d) {
                        return "translate(" + [d.x, d.y] + ")";
                    });

                    ribbon
                        .filter(function(dd) {
                            return dd.data.inner ===  d.data.inner;
                        })
                        .each(function(dd) {
                            dd.node_x = d.x;
                            dd.node_y = d.y;

                            d3.select(this).attr("d", ribbon_d_path(dd));

                            this._current = dd;
                        });
                })
                .on("end", function() {
                    animation = false;
                });

            var node_inner_g = inner.selectAll("g.node_inner")
                .data(bubble_inner(root).children)
                .enter()
                .append("g")
                    .attr("class", function(d) {
                        return "node_inner " + d.inner;
                    })
                    .attr("transform", function(d) {
                        return "translate(" + [d.x, d.y] + ")";
                    })
                .call(drag);

            var image_clip = node_inner_g
                .append("defs")
                .append("clipPath")
                    .attr("id", function(d) {
                        return "clip_" + d.data.inner;
                    })
                .append("circle")
                    .attr("cx", 0)
                    .attr("cy", 0)
                    .attr("r", function(d) {
                        return d.r - thickness;
                    });

            var image = node_inner_g
                .append("image")
                    .attr("x", function(d) {
                        return thickness - d.r;
                    })
                    .attr("y", function(d) {
                        return thickness - d.r;
                    })
                    .attr("width", function(d) {
                        return 2 * (d.r - thickness);
                    })
                    .attr("height", function(d) {
                        return 2 * (d.r - thickness);
                    })
                    .attr("xlink:href", function(d) {
                        return d.data.data[0].inner_img;
                    })
                    .style("clip-path", function(d) {
                        return "url(#clip_" + d.data.inner + ")";
                    })
                    .on("mouseover", function(d) {
                        if(animation) return;

                        var inner_label = d.data.inner.capitalize(),
                            count = d.value,
                            total = data.stats.total,
                            pct = count / total * 100,
                            html;


                        if(ribbon_choice === "all") {
                            html = inner_label + ": " + that.number_format(count) + " total" +
                                "<br>" + that.pct_label(pct) + " of total amount";
                        }
                        else {
                            total_ribbon = _(data.stats.ribbon).findWhere({"ribbon": ribbon_choice}).total,
                            pct_ribbon = count / total_ribbon * 100;

                            html = inner_label + ": " + that.number_format(count) + " " + ribbon_choice +
                                "<br>" + that.pct_label(pct_ribbon) + " of " + ribbon_choice + " -> " + inner_label;
                        }

                        html += "<br><i>Click for more details</i>";

                        that.tooltip
                            .style("visibility", "visible")
                            .html(html);

                        path_outer_g
                            .transition()
                            .style("opacity", function(dd) {
                                return d.data.inner === dd.data.inner ? 1.0 : opacity_fade;
                            });

                        ribbon
                            .transition()
                            .style("opacity", function(dd) {
                                return d.data.inner === dd.data.inner ? opacity_ribbon : opacity_fade;
                            });

                        path_inner_g
                            .transition()
                            .style("opacity", function(dd) {
                                return d.data.inner === dd.data.inner ? 1.0 : opacity_fade;
                            });

                        image
                            .transition()
                            .style("opacity", function(dd) {
                                return d.data.inner === dd.data.inner ? 1.0 : opacity_fade;
                            });
                    })
                    .on("mousemove", that.tooltip_position)
                    .on("mouseout", mouseout_default)
                    .on("click", function(d) {
                        var link = d.data.data[0].inner_link;

                        window.open(link, "_blank");
                    });

            var arc_inner = d3.arc();

            var pie_inner = d3.pie()
                .value(function(d) {
                    return d.ribbon === ribbon_choice || ribbon_choice === "all" ? d.count : 0;
                })
                .sort(null);

            function mouseover_inner(d) {
                if(animation) return;

                var outer_label = d.data.outer.capitalize(),
                    inner_name = d.data.inner,
                    inner_label = inner_name.capitalize(),
                    ribbon_label = d.data.ribbon,
                    count = d.data.count,
                    total = _(data.stats.inner).findWhere({"inner": inner_name}).total,
                    total_ribbon = _(_(data.stats.inner).findWhere({"inner": inner_name}).ribbon).findWhere({"ribbon": ribbon_label}).total,
                    pct = count / total * 100,
                    pct_ribbon = count / total_ribbon * 100;

                var html = outer_label + " -> " + ribbon_label + " -> " + inner_label + ": " + that.number_format(count);

                html += ribbon_choice === "all" ?
                    "<br>" + that.pct_label(pct) + " of total amount -> " + inner_label :
                    "<br>" + that.pct_label(pct_ribbon) + " of total amount -> " + ribbon_label + " -> " + inner_label;

                that.tooltip
                    .style("visibility", "visible")
                    .html(html);

                path_outer_g
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data._index === dd.data._index ? 1.0 : opacity_fade;
                    });

                ribbon
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data._index === dd.data._index ? opacity_ribbon : opacity_fade;
                    });

                path_inner_g
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data._index === dd.data._index ? 1.0 : opacity_fade;
                    });

                image
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data.inner === dd.data.inner ? 1.0 : opacity_fade;
                    });

            }

            var path_inner_g = node_inner_g.selectAll("g.arc_inner")
                .data(function(d) {
                    return pie_inner(d.data.data).map(function(m) {
                        m.r = d.r;
                        return m;
                    });
                })
                .enter()
                .append("g")
                    .attr("class", "arc_inner")
                    .on("mouseover", mouseover_inner)
                    .on("mousemove", that.tooltip_position)
                    .on("mouseout", mouseout_default);

            function ribbon_data(data) {
                return pie_outer(data.outer).map(function(d) {

                    var node = bubble_inner(root).children
                        .filter(function(dd) {
                            return dd.data.inner === d.data.inner;
                        });

                    d.node_x = node[0].x;
                    d.node_y = node[0].y;
                    d.node_r = node[0].r;

                    var inner = pie_inner(_(data.inner).findWhere({"inner": d.data.inner}).data)
                        .filter(function(dd) {
                            return d.data._index === dd.data._index;
                        });

                    d.inner_startAngle = inner[0].startAngle;
                    d.inner_endAngle = inner[0].endAngle;

                    return d;
                });
            }

            function ribbon_d_path(d) {
                if(d.value === 0) return "";

                var r_o = radius - thickness,
                    offset = -Math.PI / 2,
                    path_o_start = d.startAngle + offset,
                    path_o_end   = d.endAngle   + offset,
                    cx_i = -radius_pack + d.node_x,
                    cy_i = -radius_pack + d.node_y,
                    path_i_start = d.inner_startAngle + offset,
                    path_i_end   = d.inner_endAngle   + offset,
                    angle_diff = ((path_o_start + path_o_end) / 2 + (path_i_start + path_i_end) / 2) / 2,
                    r_i = d.node_r,
                    path = d3.path();

                path.arc(0, 0, r_o, path_o_start, path_o_end);
                path.bezierCurveTo(
                    r_o * Math.cos(path_o_end),
                    r_o * Math.sin(path_o_end),
                    cx_i + (r_i + ribbon_radius_cp_offset) * Math.cos(path_i_end),
                    cy_i + (r_i + ribbon_radius_cp_offset) * Math.sin(path_i_end),
                    cx_i + r_i * Math.cos(path_i_end),
                    cy_i + r_i * Math.sin(path_i_end)
                );
                path.arc(cx_i, cy_i, r_i, path_i_end, path_i_start, true);
                path.bezierCurveTo(
                    cx_i + (r_i + ribbon_radius_cp_offset) * Math.cos(path_i_start),
                    cy_i + (r_i + ribbon_radius_cp_offset) * Math.sin(path_i_start),
                    r_o * Math.cos(path_o_start),
                    r_o * Math.sin(path_o_start),
                    r_o * Math.cos(path_o_start),
                    r_o * Math.sin(path_o_start)
                );

                return path.toString();
            }

            function mouseover_ribbon(d) {
                if(animation) return;

                var outer_label = d.data.outer.capitalize(),
                    ribbon_label = d.data.ribbon,
                    inner_label = d.data.inner.capitalize(),
                    count = d.data.count;

                var html = outer_label + " -> " + ribbon_label + " -> " + inner_label + ": " + that.number_format(count);

                that.tooltip
                    .style("visibility", "visible")
                    .html(html);

                path_outer_g
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data._index === dd.data._index ? 1.0 : opacity_fade;
                    });

                ribbon
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data._index === dd.data._index ? opacity_ribbon : opacity_fade;
                    });

                path_inner_g
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data._index === dd.data._index ? 1.0 : opacity_fade;
                    });

                image
                    .transition()
                    .style("opacity", function(dd) {
                        return d.data.inner === dd.data.inner ? 1.0 : opacity_fade;
                    });
            }

            var ribbon = middle.selectAll("path")
                .data(ribbon_data(data))
                .enter()
                .append("path")
                    .attr("d", function(d) {
                        return ribbon_d_path(d);
                    })
                    .attr("class", "ribbon")
                    .style("opacity", opacity_ribbon)
                    .attr("fill", function(d) {
                        return d.data.ribbon_color;
                    })
                    .on("mouseover", mouseover_ribbon)
                    .on("mouseout", mouseout_default)
                    .on("mousemove", that.tooltip_position)
                    .each(function(d) {
                        this._current = d;
                    });

            path_inner = path_inner_g
                .append("path")
                    .attr("d", function(d) {
                        d.innerRadius = d.r - thickness;
                        d.outerRadius = d.r;

                        return arc_inner(d);
                    })
                    .style("fill", function(d) {
                        return d.data.ribbon_color;
                    })
                    .each(function(d) {
                        this._current = d;
                    });

            $("#ribbon_dropdown").on("change", function() {
                that.tooltip.style("visibility", "hidden");
                path_outer_g.style("opacity", 1.0);
                ribbon.style("opacity", opacity_ribbon);
                path_inner_g.style("opacity", 1.0);
                image.style("opacity", 1.0);

                var ribbon_choice_previous = ribbon_choice;
                ribbon_choice = this.value;

                if(ribbon_choice === ribbon_choice_previous) {
                    return;
                }

                animation = true;

                path_outer.data(pie_outer(data.outer))
                    .transition()
                    .duration(transition_duration)
                        .attrTween("d", function(d) {
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                return arc_outer(i(t));
                            };
                        });

                label_group
                    .attr("visibility", "visible")
                    .transition()
                    .duration(transition_duration)
                        .style("opacity", function(d) {
                            return d.data.ribbon === ribbon_choice || ribbon_choice === "all" ? 1.0 : 0.0;
                        })
                        .on("end", function() {
                            d3.select(this).attr("visibility", function(d) {
                                return d.data.ribbon === ribbon_choice || ribbon_choice === "all" ? "visible" : "hidden";
                            });
                        });

                label_circle.data(pie_outer(data.outer))
                    .transition()
                    .duration(transition_duration)
                        .attrTween("transform", function(d) {
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                return "translate(" + arc_outer.centroid(i(t)) + ")";
                            };
                        });

                label_line.data(pie_outer(data.outer))
                    .transition()
                    .duration(transition_duration)
                        .attrTween("x1", function(d) {
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                return arc_outer.centroid(i(t))[0];
                            };
                        })
                        .attrTween("y1", function(d) {
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                return arc_outer.centroid(i(t))[1];
                            };
                        })
                        .attrTween("x2", function(d) {
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                var c = arc_outer.centroid(i(t)),
                                    mid_angle = Math.atan2(c[1], c[0]);
                                return Math.cos(mid_angle) * radius_label;
                            };
                        })
                        .attrTween("y2", function(d) {
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                var c = arc_outer.centroid(i(t)),
                                    mid_angle = Math.atan2(c[1], c[0]);
                                return Math.sin(mid_angle) * radius_label;
                            };
                        });

                label_text_g.data(pie_outer(data.outer))
                    .transition()
                    .duration(transition_duration)
                        .attrTween("transform", function(d) {
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                var c = arc_outer.centroid(i(t)),
                                    mid_angle = Math.atan2(c[1], c[0]),
                                    x = Math.cos(mid_angle) * radius_label,
                                    adjust = x > 0 ? 5 : -5,
                                    label_x = x + adjust,
                                    label_y = Math.sin(mid_angle) * radius_label;
                                return "translate(" + [label_x, label_y] + ")";
                            };
                        });

                function end_all(transition, callback) {
                    var n = 0;
                    transition
                        .on("start", function() { ++n; })
                        .on("end", function() {
                            if(!--n) callback.apply(this, arguments);
                        });
                }

                label_text.data(pie_outer(data.outer))
                    .transition()
                    .duration(transition_duration)
                        .attrTween("text-anchor", function(d) {
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                var c = arc_outer.centroid(i(t)),
                                    mid_angle = Math.atan2(c[1], c[0]),
                                    x = Math.cos(mid_angle) * radius_label;
                                return x > 0 ? "start" : "end";
                            };
                        })
                        .call(end_all, function() {
                            animation = false;
                            mouseout_default();
                            label_relax();
                        });

                root = d3.hierarchy({"children": data.inner})
                    .sum(function(d) {
                        return _(d.data).chain()
                            .filter(function(v) {
                                return v.ribbon === ribbon_choice || ribbon_choice === "all";
                            })
                            .pluck("count")
                            .reduce(function(memo, num) {
                                return memo + num;
                            }, 0)
                            .value();
                    });

                node_inner_g.data(bubble_inner(root).children)
                    .transition()
                    .duration(transition_duration)
                        .attr("transform", function(d) {
                            return "translate(" + [d.x, d.y] + ")"
                        });

                path_inner
                    .data(function(d) {
                        return pie_inner(d.data.data).map(function(m) {
                            m.r = d.r;
                            return m;
                        })
                    })
                    .transition()
                    .duration(transition_duration)
                        .attrTween("d", function(d) {
                            d.innerRadius = d.r - thickness;
                            d.outerRadius = d.r;
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                return arc_inner(i(t));
                            };
                        });

                ribbon.data(ribbon_data(data))
                    .transition()
                    .duration(transition_duration)
                        .attrTween("d", function(d) {
                            var i = d3.interpolate(this._current, d);
                            this._current = i(0);
                            return function(t) {
                                return ribbon_d_path(i(t));
                            };
                        });

                image_clip
                    .transition()
                    .duration(transition_duration)
                        .attr("r", function(d) {
                            return d.r - thickness;
                        });

                image.data(bubble_inner(root).children)
                    .transition()
                    .duration(transition_duration)
                        .attr("x", function(d) {
                            return thickness - d.r;
                        })
                        .attr("y", function(d) {
                            return thickness - d.r;
                        })
                        .attr("width", function(d) {
                            return 2 * (d.r - thickness);
                        })
                        .attr("height", function(d) {
                            return 2 * (d.r - thickness);
                        });

            });
        },

        // Search data params
        getInitialDataParams: function() {
            return ({
                outputMode: SplunkVisualizationBase.RAW_OUTPUT_MODE,
                count: 1000000
            });
        },

        // Override to respond to re-sizing events
        reflow: function() {}
    });
});
